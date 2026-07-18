import CryptoKit
import Foundation
import XCTest
@testable import PinnedTransportCore

final class CertificateFingerprintTests: XCTestCase {
    func testNormalizesCommonSHA256FingerprintFormats() throws {
        let compact = String(repeating: "a1", count: 32)
        let colonSeparated = stride(from: 0, to: compact.count, by: 2)
            .map { index -> String in
                let start = compact.index(compact.startIndex, offsetBy: index)
                let end = compact.index(start, offsetBy: 2)
                return String(compact[start ..< end])
            }
            .joined(separator: ":")

        XCTAssertEqual(try CertificateFingerprint(compact).normalized, compact.uppercased())
        XCTAssertEqual(try CertificateFingerprint("  \(colonSeparated)\n").normalized, compact.uppercased())
        XCTAssertEqual(try CertificateFingerprint(colonSeparated.replacingOccurrences(of: ":", with: "-")).normalized, compact.uppercased())
    }

    func testRejectsMissingMalformedAndWrongLengthFingerprints() {
        XCTAssertThrowsError(try CertificateFingerprint(""))
        XCTAssertThrowsError(try CertificateFingerprint("AA:BB"))
        XCTAssertThrowsError(try CertificateFingerprint(String(repeating: "G", count: 64)))
        XCTAssertThrowsError(try CertificateFingerprint(String(repeating: "A", count: 64) + "/"))
    }

    func testMatchesLeafCertificateBytesAndRejectsDifferentBytes() throws {
        let certificate = Data("leaf certificate DER".utf8)
        let digest = SHA256.hash(data: certificate).map { String(format: "%02X", $0) }.joined(separator: ":")
        let fingerprint = try CertificateFingerprint(digest)

        XCTAssertTrue(fingerprint.matches(certificateData: certificate))
        XCTAssertFalse(fingerprint.matches(certificateData: Data("different certificate".utf8)))
    }
}
