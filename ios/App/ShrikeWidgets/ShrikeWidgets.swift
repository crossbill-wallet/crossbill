import SwiftUI
import WidgetKit

/// Crossbill's widgets for the Home Screen and the Lock Screen. They show only what the app hands them (see
/// Snapshot.swift); the app asks iOS to redraw them whenever it has something new.
@main
struct ShrikeWidgets: WidgetBundle {
    var body: some Widget {
        PriceWidget()
        BalanceWidget()
    }
}

struct ShrikeEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct ShrikeProvider: TimelineProvider {
    func placeholder(in context: Context) -> ShrikeEntry {
        ShrikeEntry(date: Date(), snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (ShrikeEntry) -> Void) {
        completion(ShrikeEntry(date: Date(), snapshot: SnapshotStore.load()))
    }

    /// One entry now, and one at each time the wording changes by itself (the price turning old, a time
    /// becoming a date after midnight). Nothing new arrives until the app reloads the widgets, so no refresh is
    /// asked for, except when the app's file is there but can't be read yet: after a restart, iOS keeps it
    /// sealed until the passcode is first entered.
    func getTimeline(in context: Context, completion: @escaping (Timeline<ShrikeEntry>) -> Void) {
        let now = Date()
        let snapshot = SnapshotStore.load()
        let dates = [now] + Freshness.changes(for: snapshot, after: now)
        let entries = dates.map { ShrikeEntry(date: $0, snapshot: snapshot) }
        if snapshot == nil && SnapshotStore.fileExists {
            completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(15 * 60))))
        } else {
            completion(Timeline(entries: entries, policy: .never))
        }
    }
}
