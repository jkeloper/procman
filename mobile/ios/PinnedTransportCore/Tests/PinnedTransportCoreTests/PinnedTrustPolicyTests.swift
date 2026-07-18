import Foundation
import XCTest
@testable import PinnedTransportCore

final class PinnedTrustPolicyTests: XCTestCase {
    private let fingerprint = String(repeating: "AB", count: 32)

    func testRequiresExpectedSecureScheme() throws {
        XCTAssertNoThrow(try makePolicy("https://192.168.1.8:47321", scheme: "https"))
        XCTAssertNoThrow(try makePolicy("wss://192.168.1.8:47321/ws", scheme: "wss"))
        XCTAssertThrowsError(try makePolicy("http://192.168.1.8:47321", scheme: "https"))
        XCTAssertThrowsError(try makePolicy("ws://192.168.1.8:47321/ws", scheme: "wss"))
    }

    func testChallengeHostMustEqualRequestHost() throws {
        let policy = try makePolicy("https://Procman.local.:47321", scheme: "https")

        XCTAssertNoThrow(try policy.validate(challengeHost: "PROCMAN.LOCAL"))
        XCTAssertThrowsError(try policy.validate(challengeHost: "other.local")) { error in
            XCTAssertEqual(
                error as? PinnedTransportError,
                .hostMismatch(expected: "procman.local", actual: "other.local")
            )
        }
    }

    func testIPChallengeHostMustBeExact() throws {
        let policy = try makePolicy("https://192.168.1.8:47321", scheme: "https")

        XCTAssertNoThrow(try policy.validate(challengeHost: "192.168.1.8"))
        XCTAssertThrowsError(try policy.validate(challengeHost: "192.168.1.9"))
    }

    func testChallengePortMustMatchWhenProvided() throws {
        let policy = try makePolicy("https://192.168.1.8:47321", scheme: "https")

        XCTAssertNoThrow(try policy.validate(challengeHost: "192.168.1.8", challengePort: 47321))
        XCTAssertThrowsError(try policy.validate(challengeHost: "192.168.1.8", challengePort: 8443))
    }

    func testRedirectCannotChangeSchemeOrHost() throws {
        let policy = try makePolicy("https://procman.local:47321/api", scheme: "https")

        XCTAssertTrue(policy.permitsRedirect(to: URL(string: "https://PROCMAN.local:47321/next")))
        XCTAssertFalse(policy.permitsRedirect(to: URL(string: "http://procman.local:47321/next")))
        XCTAssertFalse(policy.permitsRedirect(to: URL(string: "https://procman.local:47322/next")))
        XCTAssertFalse(policy.permitsRedirect(to: URL(string: "https://attacker.local/next")))
        XCTAssertFalse(policy.permitsRedirect(to: nil))
    }

    private func makePolicy(_ value: String, scheme: String) throws -> PinnedTrustPolicy {
        try PinnedTrustPolicy(
            url: XCTUnwrap(URL(string: value)),
            requiredScheme: scheme,
            fingerprint: fingerprint
        )
    }
}
