import Foundation
import Security

public struct PinnedTrustPolicy: Sendable {
    public let expectedHost: String
    public let expectedScheme: String
    public let expectedPort: Int
    public let fingerprint: CertificateFingerprint

    public init(url: URL, requiredScheme: String, fingerprint: String) throws {
        let scheme = url.scheme?.lowercased()
        guard scheme == requiredScheme.lowercased() else {
            throw PinnedTransportError.invalidScheme(expected: requiredScheme.lowercased(), actual: scheme)
        }
        guard let host = url.host, !host.isEmpty else {
            throw PinnedTransportError.missingHost
        }

        expectedHost = Self.canonicalHost(host)
        expectedScheme = requiredScheme.lowercased()
        expectedPort = url.port ?? Self.defaultPort(for: expectedScheme)
        self.fingerprint = try CertificateFingerprint(fingerprint)
    }

    public func validate(challengeHost: String, challengePort: Int? = nil) throws {
        let actual = Self.canonicalHost(challengeHost)
        guard actual == expectedHost else {
            throw PinnedTransportError.hostMismatch(expected: expectedHost, actual: actual)
        }
        // Defense in depth: a challenge for the right host on a different
        // port is not the origin this policy pinned. Structurally unreachable
        // today (single-URL sessions + port-locked redirects), so the port is
        // optional for callers that don't have one.
        if let challengePort, challengePort != expectedPort {
            throw PinnedTransportError.hostMismatch(
                expected: "\(expectedHost):\(expectedPort)",
                actual: "\(actual):\(challengePort)"
            )
        }
    }

    public func permitsRedirect(to url: URL?) -> Bool {
        guard let url,
              url.scheme?.lowercased() == expectedScheme,
              let host = url.host,
              (url.port ?? Self.defaultPort(for: expectedScheme)) == expectedPort
        else {
            return false
        }
        return Self.canonicalHost(host) == expectedHost
    }

    public func credential(
        for serverTrust: SecTrust,
        challengeHost: String,
        challengePort: Int? = nil
    ) throws -> URLCredential {
        try validate(challengeHost: challengeHost, challengePort: challengePort)

        guard let chain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate],
              let leaf = chain.first
        else {
            throw PinnedTransportError.missingLeafCertificate
        }

        let certificateData = SecCertificateCopyData(leaf) as Data
        guard fingerprint.matches(certificateData: certificateData) else {
            throw PinnedTransportError.fingerprintMismatch
        }

        // The exact leaf pin is the trust root for procman's generated
        // self-signed LAN certificate. Host binding is enforced above against
        // the URL that created this policy.
        return URLCredential(trust: serverTrust)
    }

    private static func canonicalHost(_ host: String) -> String {
        var canonical = host.lowercased()
        while canonical.hasSuffix(".") {
            canonical.removeLast()
        }
        return canonical
    }

    private static func defaultPort(for scheme: String) -> Int {
        switch scheme {
        case "https", "wss":
            return 443
        default:
            return -1
        }
    }
}
