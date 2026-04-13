import AVFoundation
import CoreAudio
import CoreMedia
import Foundation
import ScreenCaptureKit

@available(macOS 14.0, *)
final class MicRecorder {
    private let engine = AVAudioEngine()
    private var audioFile: AVAudioFile?
    private let outputURL: URL

    init(outputURL: URL) {
        self.outputURL = outputURL
    }

    func requestPermission() async -> Bool {
        await withCheckedContinuation { cont in
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                cont.resume(returning: granted)
            }
        }
    }

    func start() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        try? FileManager.default.removeItem(at: outputURL)
        audioFile = try AVAudioFile(forWriting: outputURL, settings: format.settings)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            try? self?.audioFile?.write(from: buffer)
        }
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        audioFile = nil
    }
}

@available(macOS 14.0, *)
final class AudioCaptureStream: NSObject, SCStreamOutput, SCStreamDelegate {
    private let queue = DispatchQueue(label: "glasscall.audio.capture")
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var audioInput: AVAssetWriterInput?
    private var startedSession = false
    private let outputURL: URL
    private var startTime: CMTime = .invalid
    private var lastTime: CMTime = .invalid
    private(set) var recordingDuration: Double = 0
    init(outputURL: URL) {
        self.outputURL = outputURL
        super.init()
    }

    func run() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw NSError(domain: "GlassCallAudioCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = Int(display.width)
        config.height = Int(display.height)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.capturesAudio = true
        config.sampleRate = 48000
        config.channelCount = 2

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        self.stream = stream

        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await stream.startCapture()
    }

    func stopCapture() async throws {
        if let stream {
            try await stream.stopCapture()
        }
        stream = nil
        if let audioInput {
            audioInput.markAsFinished()
        }
        if let writer, writer.status == .writing {
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                writer.finishWriting {
                    cont.resume()
                }
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }

        queue.async {
            if self.writer == nil {
                do {
                    try self.setupWriter(formatDescription: formatDesc)
                } catch {
                    fputs("Failed to setup writer: \(error)\n", stderr)
                    return
                }
            }

            guard let writer = self.writer, let audioInput = self.audioInput else { return }
            guard audioInput.isReadyForMoreMediaData else { return }

            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            if !self.startedSession {
                self.startTime = pts
                writer.startWriting()
                writer.startSession(atSourceTime: pts)
                self.startedSession = true
            }

            self.lastTime = pts

            if audioInput.append(sampleBuffer) == false {
                fputs("AVAssetWriter failed to append audio buffer\n", stderr)
            }

            if self.startTime.isValid && self.lastTime.isValid {
                self.recordingDuration = CMTimeGetSeconds(CMTimeSubtract(self.lastTime, self.startTime))
            }
        }
    }

    private func setupWriter(formatDescription: CMFormatDescription) throws {
        try? FileManager.default.removeItem(at: outputURL)

        let writer = try AVAssetWriter(url: outputURL, fileType: .m4a)
        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 192_000
        ]

        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings, sourceFormatHint: formatDescription)
        input.expectsMediaDataInRealTime = true

        guard writer.canAdd(input) else {
            throw NSError(domain: "GlassCallAudioCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot add audio input"])
        }
        writer.add(input)

        self.writer = writer
        self.audioInput = input
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("Stream stopped with error: \(error.localizedDescription)\n", stderr)
    }
}

@available(macOS 14.0, *)
@main
enum Entry {
    static func main() async {
        var systemPath: String?
        var micPath: String?
        var i = 1
        let args = CommandLine.arguments
        while i < args.count {
            if args[i] == "--mic", i + 1 < args.count {
                micPath = args[i + 1]
                i += 2
                continue
            }
            if systemPath == nil {
                systemPath = args[i]
            }
            i += 1
        }

        guard let outPath = systemPath else {
            fputs("Usage: GlassCallAudioCapture <output.m4a> [--mic <mic.wav>]\n", stderr)
            exit(2)
        }

        let outputURL = URL(fileURLWithPath: outPath)
        var mic: MicRecorder?

        if let mp = micPath {
            let micURL = URL(fileURLWithPath: mp)
            let mr = MicRecorder(outputURL: micURL)
            let ok = await mr.requestPermission()
            if !ok {
                fputs("Microphone permission denied; continuing with system audio only.\n", stderr)
            } else {
                do {
                    try mr.start()
                    mic = mr
                } catch {
                    fputs("Mic capture failed: \(error.localizedDescription); system audio only.\n", stderr)
                }
            }
        }

        let capture = AudioCaptureStream(outputURL: outputURL)

        do {
            try await capture.run()
        } catch {
            mic?.stop()
            fputs("Failed to start capture: \(error.localizedDescription)\n", stderr)
            exit(3)
        }

        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                while let line = readLine() {
                    if line.trimmingCharacters(in: .whitespacesAndNewlines) == "STOP" {
                        break
                    }
                }
                cont.resume()
            }
        }

        let recordingStop = Date()
        do {
            try await capture.stopCapture()
        } catch {
            mic?.stop()
            fputs("Failed to stop capture: \(error.localizedDescription)\n", stderr)
            exit(4)
        }

        mic?.stop()

        let finalizeDuration = Date().timeIntervalSince(recordingStop)
        _ = finalizeDuration

        // Verify the output file was actually written (no audio = Screen Recording permission denied)
        let attrs = try? FileManager.default.attributesOfItem(atPath: outPath)
        let fileSize = attrs?[.size] as? Int ?? 0
        if fileSize == 0 {
            fputs(
                "No audio data was captured. Please grant Screen Recording permission to GlassCall Notes in System Settings → Privacy & Security → Screen Recording, then restart the app.\n",
                stderr
            )
            try? FileManager.default.removeItem(atPath: outPath)
            exit(5)
        }

        // Use tracked recording duration (time between first and last audio sample)
        var durationSec: Double = capture.recordingDuration
        if durationSec <= 0 {
            let asset = AVURLAsset(url: URL(fileURLWithPath: outPath))
            durationSec = (try? await asset.load(.duration)).map { CMTimeGetSeconds($0) } ?? 0
        }

        var result: [String: Any] = [
            "outputPath": outPath,
            "durationSec": durationSec,
            "ok": true
        ]
        if let mp = micPath {
            result["micOutputPath"] = mp
        }
        if let data = try? JSONSerialization.data(withJSONObject: result),
           let json = String(data: data, encoding: .utf8)
        {
            print(json)
        }
        exit(0)
    }
}
