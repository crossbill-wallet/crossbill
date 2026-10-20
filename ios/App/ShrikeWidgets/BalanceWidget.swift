import SwiftUI
import WidgetKit

/// One wallet's balance, in BTC or sats as set in the app, as of the last time Shrike checked it with the node.
struct BalanceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ShrikeBalance", provider: ShrikeProvider()) { entry in
            BalanceWidgetView(entry: entry)
        }
        .configurationDisplayName("Balance")
        .description("A wallet’s balance as of the last time Shrike checked your node. It changes when you open Shrike.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

struct BalanceWidgetView: View {
    let entry: ShrikeEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        BackgroundAware { shows in
            let palette = makePalette(showsBackground: shows)
            content(palette: palette)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .widgetBackground(margins: !family.isLockScreen) {
                    if family.isLockScreen {
                        Color.clear
                    } else {
                        BandBackground(skin: entry.snapshot?.look.skin ?? "shrike")
                    }
                }
        }
        .widgetURL(URL(string: "shrike://wallet"))
    }

    /// The band in the app's skin. It's dark in every skin, in light and dark alike.
    private func makePalette(showsBackground: Bool) -> Palette {
        if family.isLockScreen || renderingMode != .fullColor || !showsBackground { return .plain }
        return .band(entry.snapshot?.look.skin ?? "shrike")
    }

    @ViewBuilder
    private func content(palette: Palette) -> some View {
        let s = entry.snapshot
        if let s, s.showBalance, let b = s.balance {
            switch family {
            case .accessoryCircular: circular(b)
            case .accessoryRectangular: rectangular(b)
            case .systemMedium: medium(b, palette)
            default: small(b, palette)
            }
        } else {
            let hidden = s?.showBalance == false
            let (title, detail) = hidden
                ? ("Balance hidden", "Shown again from Shrike’s Settings, Widgets.")
                : s == nil
                    ? ("Balance", "Open Shrike to show your balance here.")
                    : ("No balance yet", "Open Shrike and let it check your node.")
            switch family {
            case .accessoryCircular:
                ZStack {
                    AccessoryWidgetBackground()
                    if hidden {
                        Image(systemName: "eye.slash").font(.system(size: 16, weight: .semibold))
                    } else {
                        Text("XBT").font(.system(size: 13, weight: .semibold))
                    }
                }
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline).lineLimit(1)
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            default:
                VStack(alignment: .leading, spacing: 0) {
                    walletLine("Shrike", palette)
                    Message(title: title, detail: detail, palette: palette)
                }
            }
        }
    }

    /// The wallet's name after a dot in the skin's glow, like the eye on the app's band.
    private func walletLine(_ name: String, _ palette: Palette) -> some View {
        HStack(spacing: 6) {
            Circle().fill(palette.accent).frame(width: 7, height: 7)
            Text(name).font(.system(size: 13, weight: .semibold)).foregroundStyle(palette.dim).lineLimit(1)
        }
    }

    /// "3:42 PM", with the network when it isn't mainnet.
    private func asOf(_ b: WidgetSnapshot.Balance) -> String {
        let time = Freshness.label(b.date, now: entry.date)
        if let network = b.network { return "\(network), \(time)" }
        return time
    }

    private func small(_ b: WidgetSnapshot.Balance, _ palette: Palette) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            walletLine(b.wallet, palette)
            Spacer(minLength: 4)
            Text(b.amount)
                .font(.system(size: 24, weight: .semibold).monospacedDigit())
                .foregroundStyle(palette.text)
                .lineLimit(1)
                .minimumScaleFactor(0.45)
                .privacySensitive()
            Text(b.unit).font(.system(size: 13, weight: .semibold)).foregroundStyle(palette.dim)
            if let usd = b.usd {
                Text(usd)
                    .font(.system(size: 15).monospacedDigit())
                    .foregroundStyle(palette.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .privacySensitive()
                    .padding(.top, 4)
            }
            Spacer(minLength: 4)
            Text(asOf(b)).font(.system(size: 11)).foregroundStyle(palette.dim).lineLimit(1)
        }
    }

    private func medium(_ b: WidgetSnapshot.Balance, _ palette: Palette) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                walletLine(b.wallet, palette)
                Spacer(minLength: 8)
                Text("Shrike").font(.system(size: 13, weight: .bold)).foregroundStyle(palette.dim)
            }
            Spacer(minLength: 6)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(b.amount)
                    .font(.system(size: 32, weight: .semibold).monospacedDigit())
                    .foregroundStyle(palette.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .privacySensitive()
                Text(b.unit).font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.dim)
            }
            if let usd = b.usd {
                Text(usd)
                    .font(.system(size: 15).monospacedDigit())
                    .foregroundStyle(palette.text)
                    .privacySensitive()
                    .padding(.top, 2)
            }
            if let pending = b.pending {
                Text(pending)
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(palette.dim)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .privacySensitive()
                    .padding(.top, 2)
            }
            Spacer(minLength: 6)
            Text(asOf(b)).font(.system(size: 11)).foregroundStyle(palette.dim)
        }
    }

    private func rectangular(_ b: WidgetSnapshot.Balance) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(b.wallet).font(.headline).lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(b.amount)
                    .font(.system(size: 22, weight: .semibold).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .privacySensitive()
                    .widgetAccentable()
                Text(b.unit).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 4) {
                if let usd = b.usd {
                    Text(usd).privacySensitive()
                    Text("·")
                }
                Text(asOf(b))
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
    }

    private func circular(_ b: WidgetSnapshot.Balance) -> some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Text(b.compact)
                    .font(.system(size: 15, weight: .semibold).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .privacySensitive()
                    .widgetAccentable()
                Text(b.unit).font(.system(size: 10, weight: .semibold))
            }
            .padding(.horizontal, 5)
        }
    }
}
