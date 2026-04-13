// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GlassCallAudioCapture",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "GlassCallAudioCapture", targets: ["GlassCallAudioCapture"])
    ],
    targets: [
        .executableTarget(
            name: "GlassCallAudioCapture",
            path: "Sources/GlassCallAudioCapture"
        )
    ]
)
