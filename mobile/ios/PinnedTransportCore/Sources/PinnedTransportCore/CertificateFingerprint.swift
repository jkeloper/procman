import CryptoKit
import Foundation

public struct CertificateFingerprint: Equatable, Sendable {
    public static let byteCount = 32

    /// Uppercase hexadecimal without separators.
    public let normalized: String

    public init(_ value: String) throws {
        var hexadecimal = ""
        hexadecimal.reserveCapacity(Self.byteCount * 2)

        for character in value {
            if character.isHexDigit {
                hexadecimal.append(character)
            } else if character == ":" || character == "-" || character.isWhitespace {
                continue
            } else {
                throw PinnedTransportError.invalidFingerprint
            }
        }

        guard hexadecimal.count == Self.byteCount * 2,
              hexadecimal.unicodeScalars.allSatisfy({ scalar in
                  (48 ... 57).contains(scalar.value)
                      || (65 ... 70).contains(scalar.value)
                      || (97 ... 102).contains(scalar.value)
              })
        else {
            throw PinnedTransportError.invalidFingerprint
        }

        normalized = hexadecimal.uppercased()
    }

    public func matches(certificateData: Data) -> Bool {
        let digest = SHA256.hash(data: certificateData)
        let actual = digest.map { String(format: "%02X", $0) }.joined()
        return constantTimeEqual(normalized.utf8, actual.utf8)
    }

    private func constantTimeEqual(_ lhs: String.UTF8View, _ rhs: String.UTF8View) -> Bool {
        guard lhs.count == rhs.count else { return false }

        var difference: UInt8 = 0
        for (left, right) in zip(lhs, rhs) {
            difference |= left ^ right
        }
        return difference == 0
    }
}
