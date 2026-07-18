import Foundation

public enum PinnedTransportError: Error, Equatable, LocalizedError, Sendable {
    case invalidFingerprint
    case invalidURL
    case invalidScheme(expected: String, actual: String?)
    case missingHost
    case hostMismatch(expected: String, actual: String)
    case redirectRejected
    case missingServerTrust
    case missingLeafCertificate
    case fingerprintMismatch

    public var errorDescription: String? {
        switch self {
        case .invalidFingerprint:
            return "A valid SHA-256 certificate fingerprint is required."
        case .invalidURL:
            return "The transport URL is invalid."
        case let .invalidScheme(expected, actual):
            return "Expected URL scheme \(expected), got \(actual ?? "none")."
        case .missingHost:
            return "The transport URL must include a host."
        case let .hostMismatch(expected, actual):
            return "TLS challenge host \(actual) does not match request host \(expected)."
        case .redirectRejected:
            return "A redirect attempted to leave the pinned origin."
        case .missingServerTrust:
            return "The TLS challenge did not include server trust information."
        case .missingLeafCertificate:
            return "The TLS challenge did not include a leaf certificate."
        case .fingerprintMismatch:
            return "The server certificate fingerprint does not match the pairing fingerprint."
        }
    }
}
