import Foundation

/// What Shrike last handed to the widgets: the XBT price and one wallet's balance, already worded and formatted
/// by the app (src/app/widgets.ts). Widgets can't run Tor, so they never fetch anything themselves.
struct WidgetSnapshot: Codable {
    struct Look: Codable {
        /// "system", "light" or "dark", from Settings, Appearance
        var appearance: String
        /// "shrike", "redback", "northern" or "gilded"
        var skin: String
    }

    struct Price: Codable {
        /// "$570.25"
        var price: String
        /// "$570", for the round Lock Screen widget
        var compact: String
        /// "+1.50%" over 24 hours
        var change: String?
        /// "up", "down" or "flat"
        var direction: String?
        /// unix ms the app got this price
        var at: Double
        /// Closing prices over the last day, oldest first
        var points: [Double]?

        var date: Date { Date(timeIntervalSince1970: at / 1000) }
    }

    struct Balance: Codable {
        var wallet: String
        /// "0.12 345 678" or "12,345,678"
        var amount: String
        /// "BTC" or "sats"
        var unit: String
        /// "0.123" or "12.3M", for the round Lock Screen widget
        var compact: String
        /// "$70.41", on mainnet when there's a price
        var usd: String?
        /// "+0.01 000 000 BTC unconfirmed"
        var pending: String?
        /// nil on mainnet, "Testnet4" or "Regtest" otherwise
        var network: String?
        /// unix ms the app last checked this balance
        var at: Double

        var date: Date { Date(timeIntervalSince1970: at / 1000) }
    }

    var v: Int
    var look: Look
    /// False when prices are off in the app's Settings
    var prices: Bool
    var price: Price?
    /// False when the balance is kept out of the widgets in the app's Settings
    var showBalance: Bool
    var balance: Balance?
}

extension WidgetSnapshot {
    /// Shapes for the redacted placeholder iOS draws while a widget loads. Never shown as real numbers.
    static let placeholder = WidgetSnapshot(
        v: 1,
        look: Look(appearance: "system", skin: "shrike"),
        prices: true,
        price: Price(price: "$000.00", compact: "$000", change: "+0.00%", direction: "flat", at: Date().timeIntervalSince1970 * 1000, points: nil),
        showBalance: true,
        balance: Balance(wallet: "Wallet", amount: "0.00 000 000", unit: "BTC", compact: "0.000", usd: nil, pending: nil, network: nil, at: Date().timeIntervalSince1970 * 1000)
    )
}

enum SnapshotStore {
    /// The App Group the widgets share with the app: "group." and the app's bundle ID. This extension's bundle ID
    /// is the app's with ".widgets" on the end (scripts/ios-widgets.mjs sets both up).
    static var groupID: String? {
        guard let id = Bundle.main.bundleIdentifier else { return nil }
        let suffix = ".widgets"
        let app = id.hasSuffix(suffix) ? String(id.dropLast(suffix.count)) : id
        return "group.\(app)"
    }

    /// The file the app writes (ShrikeNativePlugin.widgetsUpdate).
    static var fileURL: URL? {
        guard let group = groupID,
              let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return dir.appendingPathComponent("Library/Application Support/Widgets", isDirectory: true)
            .appendingPathComponent("snapshot.json", isDirectory: false)
    }

    /// Whether the app has written the file, readable or not.
    static var fileExists: Bool {
        guard let url = fileURL else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    static func load() -> WidgetSnapshot? {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }
}

/// How a widget words the time it got its numbers, and when a price counts as old.
enum Freshness {
    /// After this, the price is drawn dimmed: it may be well off by now
    static let staleAfter: TimeInterval = 60 * 60

    /// "3:42 PM" today, "Oct 19" before that.
    static func label(_ at: Date, now: Date) -> String {
        if Calendar.current.isDate(at, inSameDayAs: now) {
            return at.formatted(date: .omitted, time: .shortened)
        }
        return at.formatted(.dateTime.month(.abbreviated).day())
    }

    static func isStale(_ at: Date, now: Date) -> Bool {
        now.timeIntervalSince(at) > staleAfter
    }

    /// Times after `now` at which a widget's wording changes on its own: when the price turns old, and at the
    /// midnight after which "3:42 PM" has to become a date.
    static func changes(for snapshot: WidgetSnapshot?, after now: Date) -> [Date] {
        var out: [Date] = []
        if let at = snapshot?.price?.date {
            out.append(at.addingTimeInterval(staleAfter))
        }
        for at in [snapshot?.price?.date, snapshot?.balance?.date].compactMap({ $0 }) {
            if let midnight = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: at)) {
                out.append(midnight)
            }
        }
        return Array(Set(out.filter { $0 > now })).sorted()
    }
}
