import SwiftUI
import WidgetKit

// Colors are the app's own, from src/ui/styles.css: the price widget looks like the Market tab's price card
// (paper and ink, light or dark), and the balance widget like the Wallet tab's band, in the skin picked in the
// app. tests/widgets.test.ts checks these against the stylesheet.

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: opacity
        )
    }
}

struct Palette {
    var background: Color
    var text: Color
    var dim: Color
    var accent: Color
    var line: Color
    var fill: Color

    /// The Market tab's price card. Light: --paper, --ink, --slate, --eye. Dark: the same in dark.
    static func paper(dark: Bool) -> Palette {
        dark
            ? Palette(background: Color(hex: 0x1b2124), text: Color(hex: 0xe8ecee), dim: Color(hex: 0x97a3aa), accent: Color(hex: 0x4fd5e8),
                      line: Color(hex: 0xe8ecee), fill: Color(hex: 0xe8ecee, opacity: 0.07))
            : Palette(background: Color(hex: 0xffffff), text: Color(hex: 0x1d2327), dim: Color(hex: 0x5b676e), accent: Color(hex: 0x13899b),
                      line: Color(hex: 0x1d2327), fill: Color(hex: 0x1d2327, opacity: 0.06))
    }

    /// The Wallet tab's band in each skin: --on-mask, --on-mask-dim and --eye-glow. Every band is dark.
    static func band(_ skin: String) -> Palette {
        let c = bandColors(skin)
        return Palette(background: Color(hex: 0x000000), text: Color(hex: c.text), dim: Color(hex: c.dim), accent: Color(hex: c.glow),
                       line: Color(hex: c.text), fill: Color(hex: c.text, opacity: 0.08))
    }

    private static func bandColors(_ skin: String) -> (text: UInt32, dim: UInt32, glow: UInt32) {
        switch skin {
        case "redback": return (0xfff8f3, 0xe3c0ae, 0xffb36b)
        case "northern": return (0xf3f8ff, 0xa9bed2, 0x7ff0c8)
        case "gilded": return (0xfffaf0, 0xcfc09a, 0xe8c46e)
        default: return (0xffffff, 0xa9b3b9, 0x3fd6e8)
        }
    }

    /// For the Lock Screen, StandBy and tinted Home Screens, where iOS colors the widget itself.
    static let plain = Palette(background: .clear, text: .primary, dim: .secondary, accent: .primary, line: .primary, fill: Color.primary.opacity(0.12))
}

/// The band behind the balance, as each skin draws it in the app.
struct BandBackground: View {
    let skin: String

    var body: some View {
        switch skin {
        case "redback":
            // linear-gradient(165deg, #52200f, #2a0f08)
            LinearGradient(colors: [Color(hex: 0x52200f), Color(hex: 0x2a0f08)], startPoint: UnitPoint(x: 0.37, y: 0), endPoint: UnitPoint(x: 0.63, y: 1))
        case "northern":
            // #0b1626 with a green glow from the top right and a blue one from the top left
            ZStack {
                Color(hex: 0x0b1626)
                RadialGradient(colors: [Color(hex: 0x17544d), Color(hex: 0x17544d, opacity: 0)], center: .topTrailing, startRadius: 0, endRadius: 200)
                RadialGradient(colors: [Color(hex: 0x22346a), Color(hex: 0x22346a, opacity: 0)], center: .topLeading, startRadius: 0, endRadius: 170)
            }
        case "gilded":
            // linear-gradient(165deg, #211c11, #0a0905)
            LinearGradient(colors: [Color(hex: 0x211c11), Color(hex: 0x0a0905)], startPoint: UnitPoint(x: 0.37, y: 0), endPoint: UnitPoint(x: 0.63, y: 1))
        default:
            Color(hex: 0x000000)
        }
    }
}

extension WidgetFamily {
    var isLockScreen: Bool {
        switch self {
        case .accessoryCircular, .accessoryRectangular, .accessoryInline: return true
        default: return false
        }
    }
}

extension View {
    /// The widget's background. From iOS 17, iOS draws it with its own margins and leaves it out where a
    /// background doesn't belong (StandBy, tinted Home Screens, the Lock Screen). iOS 16 needs it drawn here,
    /// with margins on the Home Screen.
    @ViewBuilder
    func widgetBackground<Fill: View>(margins: Bool, @ViewBuilder _ fill: () -> Fill) -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(for: .widget) { fill() }
        } else if margins {
            padding(16).background(fill())
        } else {
            background(fill())
        }
    }
}

/// Tells its content whether iOS is drawing the widget's background. In StandBy and on tinted Home Screens it
/// isn't, and the app's own colors would be unreadable there.
struct BackgroundAware<Content: View>: View {
    @ViewBuilder let content: (Bool) -> Content

    var body: some View {
        if #available(iOS 17.0, *) {
            BackgroundAware17(content: content)
        } else {
            content(true)
        }
    }
}

@available(iOS 17.0, *)
private struct BackgroundAware17<Content: View>: View {
    @Environment(\.showsWidgetContainerBackground) private var shows
    let content: (Bool) -> Content

    var body: some View {
        content(shows)
    }
}

/// The day's price as a line, scaled as the Market tab's chart is: 8% of the range above and below.
struct SparkShape: Shape {
    let points: [Double]
    var closed = false

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard points.count >= 2, let lo = points.min(), let hi = points.max() else { return path }
        let span = hi - lo
        let pad = span > 0 ? span * 0.08 : max(abs(hi) * 0.01, 1)
        let low = lo - pad
        let range = (hi + pad) - low
        func point(_ i: Int) -> CGPoint {
            CGPoint(
                x: rect.minX + rect.width * CGFloat(i) / CGFloat(points.count - 1),
                y: rect.maxY - rect.height * CGFloat((points[i] - low) / range)
            )
        }
        path.move(to: point(0))
        for i in 1..<points.count {
            path.addLine(to: point(i))
        }
        if closed {
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            path.closeSubpath()
        }
        return path
    }
}

struct Sparkline: View {
    let points: [Double]
    let palette: Palette

    var body: some View {
        ZStack {
            SparkShape(points: points, closed: true).fill(palette.fill)
            SparkShape(points: points).stroke(palette.line, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
        }
    }
}

/// The small arrow beside the 24-hour change, as on the Market tab. Its shape carries the direction, not a color.
struct Arrow: Shape {
    let up: Bool

    func path(in r: CGRect) -> Path {
        var p = Path()
        if up {
            p.move(to: CGPoint(x: r.midX, y: r.minY))
            p.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
            p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
        } else {
            p.move(to: CGPoint(x: r.minX, y: r.minY))
            p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
            p.addLine(to: CGPoint(x: r.midX, y: r.maxY))
        }
        p.closeSubpath()
        return p
    }
}

/// "▲ +1.50% 24h", or nothing when the exchange gave no change.
struct ChangeLine: View {
    let price: WidgetSnapshot.Price
    let palette: Palette
    var size: CGFloat = 13
    var label = true

    var body: some View {
        if let change = price.change {
            HStack(spacing: 4) {
                if let d = price.direction, d != "flat" {
                    Arrow(up: d == "up").fill(palette.text).frame(width: size * 0.62, height: size * 0.55)
                }
                Text(change).font(.system(size: size, weight: .semibold).monospacedDigit()).foregroundStyle(palette.text)
                if label {
                    Text("24h").font(.system(size: size)).foregroundStyle(palette.dim)
                }
            }
            .lineLimit(1)
        }
    }
}

/// The bird from the app's icon, in a corner of the price widget.
struct Bird: View {
    let size: CGFloat

    var body: some View {
        Image("Bird").resizable().scaledToFit().frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// A widget with nothing to show yet, and why.
struct Message: View {
    let title: String
    let detail: String
    let palette: Palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.text)
            Text(detail).font(.system(size: 12)).foregroundStyle(palette.dim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
    }
}
