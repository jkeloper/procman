// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PinnedTransportCore",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
    ],
    products: [
        .library(name: "PinnedTransportCore", targets: ["PinnedTransportCore"]),
    ],
    targets: [
        .target(name: "PinnedTransportCore"),
        .testTarget(
            name: "PinnedTransportCoreTests",
            dependencies: ["PinnedTransportCore"]
        ),
    ]
)
