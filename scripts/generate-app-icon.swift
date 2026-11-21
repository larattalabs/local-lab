// Rebuild Local Lab's macOS icon with: swift scripts/generate-app-icon.swift
// AppKit/CoreGraphics only; no third-party tools or model runtime required.
import AppKit
import Foundation

let destination = URL(fileURLWithPath: CommandLine.arguments.count > 1
  ? CommandLine.arguments[1] : "resources/brand", isDirectory: true)
let manager = FileManager.default
try manager.createDirectory(at: destination, withIntermediateDirectories: true)
let iconset = manager.temporaryDirectory.appendingPathComponent("local-lab-\(UUID().uuidString).iconset")
try manager.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? manager.removeItem(at: iconset) }
let space = CGColorSpaceCreateDeviceRGB()
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
  CGColor(colorSpace: space, components: [r, g, b, a])!
}
func render(_ size: Int) -> Data {
  let c = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
    bytesPerRow: size * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  c.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
  c.translateBy(x: 0, y: 1024)
  c.scaleBy(x: 1, y: -1)
  let tile = CGPath(roundedRect: CGRect(x: 64, y: 64, width: 896, height: 896),
                    cornerWidth: 202, cornerHeight: 202, transform: nil)
  c.saveGState()
  c.addPath(tile); c.clip()
  let background = CGGradient(colorsSpace: space,
    colors: [color(0.16, 0.18, 0.21), color(0.045, 0.055, 0.07)] as CFArray,
    locations: [0, 1])!
  c.drawLinearGradient(background, start: CGPoint(x: 240, y: 80), end: CGPoint(x: 760, y: 940), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  c.restoreGState()
  c.addPath(tile); c.setStrokeColor(color(0.45, 0.48, 0.53, 0.3)); c.setLineWidth(3); c.strokePath()

  let flask = CGMutablePath()
  flask.move(to: CGPoint(x: 448, y: 278))
  flask.addLine(to: CGPoint(x: 448, y: 425))
  flask.addCurve(to: CGPoint(x: 420, y: 482), control1: CGPoint(x: 448, y: 445), control2: CGPoint(x: 431, y: 463))
  flask.addLine(to: CGPoint(x: 332, y: 660))
  flask.addCurve(to: CGPoint(x: 400, y: 778), control1: CGPoint(x: 300, y: 724), control2: CGPoint(x: 330, y: 778))
  flask.addLine(to: CGPoint(x: 624, y: 778))
  flask.addCurve(to: CGPoint(x: 692, y: 660), control1: CGPoint(x: 694, y: 778), control2: CGPoint(x: 724, y: 724))
  flask.addLine(to: CGPoint(x: 604, y: 482))
  flask.addCurve(to: CGPoint(x: 576, y: 425), control1: CGPoint(x: 593, y: 463), control2: CGPoint(x: 576, y: 445))
  flask.addLine(to: CGPoint(x: 576, y: 278)); flask.closeSubpath()
  c.addPath(flask); c.setFillColor(color(0.065, 0.075, 0.09)); c.fillPath()
  c.saveGState(); c.addPath(flask); c.clip()
  let liquid = CGMutablePath()
  liquid.move(to: CGPoint(x: 300, y: 628))
  liquid.addCurve(to: CGPoint(x: 535, y: 630), control1: CGPoint(x: 400, y: 570), control2: CGPoint(x: 465, y: 680))
  liquid.addCurve(to: CGPoint(x: 730, y: 635), control1: CGPoint(x: 600, y: 585), control2: CGPoint(x: 680, y: 600))
  liquid.addLine(to: CGPoint(x: 740, y: 820)); liquid.addLine(to: CGPoint(x: 290, y: 820)); liquid.closeSubpath()
  c.addPath(liquid); c.clip()
  let gold = CGGradient(colorsSpace: space,
    colors: [color(0.98, 0.77, 0.40), color(0.72, 0.40, 0.13)] as CFArray, locations: [0, 1])!
  c.drawLinearGradient(gold, start: CGPoint(x: 400, y: 590), end: CGPoint(x: 650, y: 810), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  c.restoreGState()
  c.addPath(flask); c.setLineWidth(29); c.setLineJoin(.round)
  c.setStrokeColor(color(0.91, 0.89, 0.83)); c.strokePath()
  c.setFillColor(color(0.91, 0.89, 0.83))
  c.addPath(CGPath(roundedRect: CGRect(x: 416, y: 246, width: 192, height: 32),
                   cornerWidth: 16, cornerHeight: 16, transform: nil)); c.fillPath()
  c.setStrokeColor(color(0.88, 0.66, 0.32)); c.setLineWidth(16); c.setLineCap(.round)
  c.move(to: CGPoint(x: 483, y: 475)); c.addLine(to: CGPoint(x: 541, y: 475)); c.strokePath()
  for (x, y, radius, alpha): (CGFloat, CGFloat, CGFloat, CGFloat) in [
    (470, 697, 13, 0.65), (581, 728, 9, 0.48), (514, 568, 12, 0.8),
  ] {
    c.setFillColor(color(1, 0.88, 0.62, alpha))
    c.fillEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
  }
  c.setFillColor(color(0.85, 0.65, 0.34))
  c.fillEllipse(in: CGRect(x: 680, y: 321, width: 40, height: 40))
  c.setFillColor(color(0.85, 0.65, 0.34, 0.4))
  c.fillEllipse(in: CGRect(x: 327, y: 372, width: 18, height: 18))
  return NSBitmapImageRep(cgImage: c.makeImage()!).representation(using: .png, properties: [:])!
}

let entries: [(Int, String)] = [(16, "icon_16x16"), (32, "icon_16x16@2x"),
  (32, "icon_32x32"), (64, "icon_32x32@2x"), (128, "icon_128x128"),
  (256, "icon_128x128@2x"), (256, "icon_256x256"), (512, "icon_256x256@2x"),
  (512, "icon_512x512"), (1024, "icon_512x512@2x")]
for (size, name) in entries { try render(size).write(to: iconset.appendingPathComponent(name + ".png")) }
try render(1024).write(to: destination.appendingPathComponent("icon.png"))
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", destination.appendingPathComponent("icon.icns").path]
try process.run(); process.waitUntilExit()
guard process.terminationStatus == 0 else { fatalError("iconutil failed") }
print("Generated icon.png and icon.icns in \(destination.path)")
