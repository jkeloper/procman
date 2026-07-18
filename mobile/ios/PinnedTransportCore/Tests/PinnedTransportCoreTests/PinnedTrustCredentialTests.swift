import CryptoKit
import Foundation
import Security
import XCTest
@testable import PinnedTransportCore

final class PinnedTrustCredentialTests: XCTestCase {
    func testSecTrustLeafMatchSucceedsForExpectedHost() throws {
        let certificateData = try XCTUnwrap(Data(base64Encoded: Self.localhostCertificateDER))
        let trust = try makeTrust(certificateData: certificateData)
        let policy = try PinnedTrustPolicy(
            url: XCTUnwrap(URL(string: "https://127.0.0.1:47321/api")),
            requiredScheme: "https",
            fingerprint: fingerprint(of: certificateData)
        )

        XCTAssertNoThrow(try policy.credential(for: trust, challengeHost: "127.0.0.1"))
    }

    func testSecTrustLeafMismatchFailsClosed() throws {
        let certificateData = try XCTUnwrap(Data(base64Encoded: Self.localhostCertificateDER))
        let trust = try makeTrust(certificateData: certificateData)
        let policy = try PinnedTrustPolicy(
            url: XCTUnwrap(URL(string: "https://127.0.0.1:47321/api")),
            requiredScheme: "https",
            fingerprint: String(repeating: "00", count: 32)
        )

        XCTAssertThrowsError(try policy.credential(for: trust, challengeHost: "127.0.0.1")) { error in
            XCTAssertEqual(error as? PinnedTransportError, .fingerprintMismatch)
        }
    }

    func testSecTrustCannotBeReusedForDifferentChallengeHost() throws {
        let certificateData = try XCTUnwrap(Data(base64Encoded: Self.localhostCertificateDER))
        let trust = try makeTrust(certificateData: certificateData)
        let policy = try PinnedTrustPolicy(
            url: XCTUnwrap(URL(string: "https://127.0.0.1:47321/api")),
            requiredScheme: "https",
            fingerprint: fingerprint(of: certificateData)
        )

        XCTAssertThrowsError(try policy.credential(for: trust, challengeHost: "localhost")) { error in
            XCTAssertEqual(
                error as? PinnedTransportError,
                .hostMismatch(expected: "127.0.0.1", actual: "localhost")
            )
        }
    }

    private func makeTrust(certificateData: Data) throws -> SecTrust {
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, certificateData as CFData))
        let policy = SecPolicyCreateSSL(true, "localhost" as CFString)
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(certificate, policy, &trust), errSecSuccess)
        return try XCTUnwrap(trust)
    }

    private func fingerprint(of data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02X", $0) }.joined(separator: ":")
    }

    // Short-lived, self-signed localhost fixture used only to exercise the
    // same SecTrust leaf extraction path as URLSession challenges.
    private static let localhostCertificateDER = "MIIDUzCCAjugAwIBAgIUfmdlD5ru5gvrHrZ6axpWzdnu/c8wDQYJKoZIhvcNAQELBQAwKzESMBAGA1UEAwwJbG9jYWxob3N0MRUwEwYDVQQKDAxwcm9jbWFuLXRlc3QwHhcNMjYwNzE2MTQzNjQ1WhcNMjYwNzE3MTQzNjQ1WjArMRIwEAYDVQQDDAlsb2NhbGhvc3QxFTATBgNVBAoMDHByb2NtYW4tdGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAI6OTUndvae2Rn2aH6SAL3eFDzLJqgAWxDQwH+cbqKCWoQ88TQIV5/sbj3yaumV8ziGuUNzMYBSZ6tvpa1c9ETm18aCy9zx3XiGs8KFW2qane4WJ9ZDgrjg2vGdo84GubXCCxDjgX9/r0UfkrJ2WY1cQuS24KPSaw73TuiAilKBDLNmDQj/EOthJgp7I4ax/oYW+POAbO1j+/1ObSVbRjWzGWbje4YWrNB65kwEeHq9td8QMFzxm5oXr8pX/77uSR1jwvKphbde61IAyxrRDG3VXoNjvSVe3y/gHMc6eDRGhaddrPPIkdItZrCnuHCTLHVcSZmPQPav3AFD4hvo89UsCAwEAAaNvMG0wHQYDVR0OBBYEFCFUf0fuSjkiZT6HNTlRRfeuh/4hMB8GA1UdIwQYMBaAFCFUf0fuSjkiZT6HNTlRRfeuh/4hMA8GA1UdEwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQCGkiNw6dAigNuDJxxxxiYsTE81YqKE7sIC1As/pLS+ETZMvRFi6nRVx8oIXuOsaW5v4tCjUo7zvX3BgWA5yHfOUx78hRyxFDwWdS29lICrv1Hi00hwGA3B9Gp89TzphTJYteagEuZIgQUY1G83iHTISxdKyJAii7XI1p6Cd0hdkKWppG2Ej+JusGssOOBz64CtyMqCVkZoBy4Dstz4GUeFkEjb1pILn2/Gew86XnaTr+NUjyosYNFVZ3BCeNmzYO9lqsnXgOpAo0C5cUiVBTyX07XvYXP93o8d77OWHEAgeD0kvEJfPMdiBgdxl42R+DkGOi+vcjPXB3yv7Xfc7NmQ"
}
