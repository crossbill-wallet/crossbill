require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'ShrikeNative'
  s.version = package['version']
  s.summary = 'Tor, Keychain and QR scanning for Crossbill'
  s.license = 'Apache-2.0'
  s.homepage = 'https://github.com/crossbill-wallet/crossbill'
  s.author = 'Crossbill'
  s.source = { :git => 'https://github.com/crossbill-wallet/crossbill.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.swift'
  s.ios.deployment_target = '16.0'
  s.swift_version = '5.9'
  s.dependency 'Capacitor'
  # Embedded C Tor (tor 0.4.9.x) from iCepa/Tor.framework, the library Onion Browser uses
  s.dependency 'Tor', '~> 409.14'
  s.frameworks = 'VisionKit', 'LocalAuthentication', 'Security', 'AVFoundation', 'UIKit', 'WidgetKit', 'Network', 'CryptoKit'
end
