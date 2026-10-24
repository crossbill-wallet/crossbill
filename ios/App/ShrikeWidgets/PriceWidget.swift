import SwiftUI
import WidgetKit

/// The XBT price Crossbill last got from Neoxa Exchange, through Tor, with the day's change and chart.
struct PriceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ShrikePrice", provider: ShrikeProvider()) { entry in
            PriceWidgetView(entry: entry)
        }
        .configurationDisplayName("XBT price")
        .description("The last price Crossbill got from Neoxa Exchange through Tor. It changes when you open Crossbill.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

struct PriceWidgetView: View {
    let entry: ShrikeEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        BackgroundAware { shows in
            let palette = makePalette(showsBackground: shows)
            content(palette: palette)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .widgetBackground(margins: !family.isLockScreen) {
                    if family.isLockScreen { Color.clear } else { palette.background }
                }
        }
        .widgetURL(URL(string: "crossbill://market"))
    }

    /// Paper and ink, light or dark as set in the app (or as the iPhone is, for Match iPhone).
    private func makePalette(showsBackground: Bool) -> Palette {
        if family.isLockScreen || renderingMode != .fullColor || !showsBackground { return .plain }
        switch entry.snapshot?.look.appearance {
        case "dark": return .paper(dark: true)
        case "light": return .paper(dark: false)
        default: return .paper(dark: colorScheme == .dark)
        }
    }

    @ViewBuilder
    private func content(palette: Palette) -> some View {
        let s = entry.snapshot
        if let s, s.prices, let price = s.price {
            switch family {
            case .accessoryCircular: circular(price, palette)
            case .accessoryRectangular: rectangular(price, palette)
            case .systemMedium: medium(price, palette)
            default: small(price, palette)
            }
        } else {
            let (title, detail) = s == nil
                ? ("XBT price", "Open Crossbill to show the price here.")
                : s?.prices == false
                    ? ("Prices are off", "Turn on XBT price in Crossbill’s Settings.")
                    : ("No price yet", "Open Crossbill’s Market tab to get it.")
            switch family {
            case .accessoryCircular:
                ZStack {
                    AccessoryWidgetBackground()
                    Text("XBT").font(.system(size: 13, weight: .semibold))
                }
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline).lineLimit(1)
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            default:
                VStack(alignment: .leading, spacing: 0) {
                    header(palette, birdSize: 20)
                    Message(title: title, detail: detail, palette: palette)
                }
            }
        }
    }

    private func stale(_ price: WidgetSnapshot.Price) -> Bool {
        Freshness.isStale(price.date, now: entry.date)
    }

    private func header(_ palette: Palette, birdSize: CGFloat) -> some View {
        HStack(alignment: .center, spacing: 6) {
            Text("XBT").font(.system(size: 13, weight: .bold)).foregroundStyle(palette.text)
            Text("USDC").font(.system(size: 13)).foregroundStyle(palette.dim)
            Spacer(minLength: 4)
            if renderingMode == .fullColor {
                Bird(size: birdSize)
            }
        }
    }

    private func small(_ price: WidgetSnapshot.Price, _ palette: Palette) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header(palette, birdSize: 22)
            Text(price.price)
                .font(.system(size: 26, weight: .semibold).monospacedDigit())
                .foregroundStyle(stale(price) ? palette.dim : palette.text)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .padding(.top, 4)
            ChangeLine(price: price, palette: palette, size: 12)
                .padding(.top, 1)
            Spacer(minLength: 6)
            if let points = price.points, points.count >= 2 {
                Sparkline(points: points, palette: palette)
                    .frame(maxHeight: 34)
                    .padding(.bottom, 4)
            }
            Text(Freshness.label(price.date, now: entry.date))
                .font(.system(size: 11))
                .foregroundStyle(palette.dim)
        }
    }

    private func medium(_ price: WidgetSnapshot.Price, _ palette: Palette) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text("XBT").font(.system(size: 13, weight: .bold)).foregroundStyle(palette.text)
                        Text("USDC").font(.system(size: 13)).foregroundStyle(palette.dim)
                    }
                    Text(price.price)
                        .font(.system(size: 30, weight: .semibold).monospacedDigit())
                        .foregroundStyle(stale(price) ? palette.dim : palette.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                    ChangeLine(price: price, palette: palette)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 3) {
                    if renderingMode == .fullColor {
                        Bird(size: 26)
                    }
                    Text("Neoxa Exchange").font(.system(size: 11)).foregroundStyle(palette.dim)
                    Text(Freshness.label(price.date, now: entry.date)).font(.system(size: 11)).foregroundStyle(palette.dim)
                }
            }
            Spacer(minLength: 8)
            if let points = price.points, points.count >= 2 {
                Sparkline(points: points, palette: palette)
                    .frame(maxHeight: 46)
            }
        }
    }

    private func rectangular(_ price: WidgetSnapshot.Price, _ palette: Palette) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                Text("XBT").font(.headline)
                Spacer(minLength: 2)
                ChangeLine(price: price, palette: palette, size: 12, label: false)
            }
            Text(price.price)
                .font(.system(size: 24, weight: .semibold).monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .widgetAccentable()
            Text(Freshness.label(price.date, now: entry.date))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func circular(_ price: WidgetSnapshot.Price, _ palette: Palette) -> some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 1) {
                Text("XBT").font(.system(size: 10, weight: .semibold))
                Text(price.compact)
                    .font(.system(size: 15, weight: .semibold).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .widgetAccentable()
                if let d = price.direction, d != "flat" {
                    Arrow(up: d == "up").fill(palette.text).frame(width: 7, height: 6)
                }
            }
            .padding(.horizontal, 5)
        }
    }
}
