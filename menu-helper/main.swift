import Cocoa

func connectionTokenURL(project: URL, environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
    let state = environment["PRINT_CHAMBER_STATE"].map {
        URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath)
    } ?? project.appendingPathComponent(".local")
    return state.standardizedFileURL.resolvingSymlinksInPath().appendingPathComponent("token")
}

let repositoryURL = URL(string: "https://github.com/abelguan02/print-chamber")!
let issuesURL = URL(string: "https://github.com/abelguan02/print-chamber/issues")!
let runningStates = ["ready", "loading", "busy", "failed", "unreachable"]

final class LinkButton: NSButton { var url: URL? }

final class AboutWindow: NSWindow {
    // Accessory apps have no main menu, so Esc and ⌘W are handled here.
    override func cancelOperation(_ sender: Any?) { close() }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command && event.charactersIgnoringModifiers == "w" {
            close(); return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

final class Helper: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let stateItem = NSMenuItem(title: "正在检查…", action: nil, keyEquivalent: "")
    var startItem: NSMenuItem!
    var stopItem: NSMenuItem!
    var restartItem: NSMenuItem!
    var timer: Timer?
    var pending = false
    var controllerFailed = false
    var state = "unknown"
    var flashUntil = Date.distantPast
    var aboutWindow: AboutWindow?
    let root = URL(fileURLWithPath: Bundle.main.object(forInfoDictionaryKey: "ProjectRoot") as! String)
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "未知"

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let index = CommandLine.arguments.firstIndex(of: "--render-about"), index + 1 < CommandLine.arguments.count {
            renderAbout(to: URL(fileURLWithPath: CommandLine.arguments[index + 1])); NSApp.terminate(nil); return
        }
        // Launch Services normally reuses the app; also guard direct binary launches.
        if NSRunningApplication.runningApplications(withBundleIdentifier: "local.printchamber.helper")
            .contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            NSApp.terminate(nil); return
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        setIcon("printer", "Print Chamber")
        let menu = NSMenu()
        menu.autoenablesItems = false
        let title = NSMenuItem(title: "Print Chamber · 本地模型", action: nil, keyEquivalent: "")
        title.isEnabled = false; menu.addItem(title)
        stateItem.isEnabled = false; menu.addItem(stateItem)
        menu.addItem(.separator())
        startItem = item("启动模型", #selector(startModel), menu)
        stopItem = item("停止模型", #selector(stopModel), menu)
        restartItem = item("重启模型", #selector(restartModel), menu)
        startItem.isEnabled = false; stopItem.isEnabled = false; restartItem.isEnabled = false
        let hint = NSMenuItem(title: "仅手动启动 · 不随登录加载模型", action: nil, keyEquivalent: "")
        hint.isEnabled = false; menu.addItem(hint)
        menu.addItem(.separator())
        item("复制插件连接码", #selector(copyToken), menu)
        item("打开使用说明", #selector(openHelp), menu)
        item("查看运行日志", #selector(openLog), menu)
        menu.addItem(.separator())
        item("关于 Print Chamber…", #selector(showAbout), menu)
        item("退出小助手…", #selector(quit), menu)
        statusItem.menu = menu
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer!, forMode: .common)
    }

    @discardableResult func item(_ title: String, _ selector: Selector, _ menu: NSMenu) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        entry.target = self; menu.addItem(entry); return entry
    }

    func setIcon(_ symbol: String, _ description: String) {
        statusItem.button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: description)
        statusItem.button?.image?.isTemplate = true
    }

    // Briefly confirm a silent action in the menu bar itself, since the menu closes on click.
    func flash(_ text: String, symbol: String) {
        flashUntil = Date().addingTimeInterval(2)
        stateItem.title = text; setIcon(symbol, text)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.1) { self.refresh() }
    }

    func refresh() { run("status") }
    func run(_ action: String, then: ((String) -> Void)? = nil) {
        guard !pending else {
            // A user action waits for the in-flight status check instead of being dropped.
            if action != "status" { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.run(action, then: then) } }
            return
        }
        pending = true
        if action != "status" {
            startItem.isEnabled = false; stopItem.isEnabled = false; restartItem.isEnabled = false
        }
        if let progress = ["start": "正在启动…", "stop": "正在停止…", "restart": "正在重启…"][action] {
            stateItem.title = progress; flashUntil = .distantPast
        }
        let project = root
        DispatchQueue.global(qos: .utility).async {
            let process = Process(), pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            process.arguments = [project.appendingPathComponent("menu-helper/controller.py").path, action]
            process.standardOutput = pipe
            let logURL = project.appendingPathComponent(".local/helper.log")
            try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                     attributes: [.posixPermissions: 0o700])
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
            }
            let errorLog = try? FileHandle(forWritingTo: logURL)
            errorLog?.seekToEndOfFile()
            process.standardError = errorLog ?? FileHandle.nullDevice
            var result: [String: Any] = ["state": "error", "label": "无法管理模型，请查看日志"]
            do {
                try process.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                if let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] { result = parsed }
            } catch {
                errorLog?.write(Data("CONTROL_LAUNCH_FAILED\n".utf8))
            }
            try? errorLog?.close()
            let response = result
            DispatchQueue.main.async {
                self.pending = false
                let state = response["state"] as? String ?? "error"
                let label = response["label"] as? String ?? "状态未知"
                self.state = state
                self.controllerFailed = state == "error"
                let canStart = state == "stopped"
                let canStop = ["ready", "loading", "failed", "unreachable"].contains(state)
                if self.startItem.isEnabled != canStart { self.startItem.isEnabled = canStart }
                if self.stopItem.isEnabled != canStop { self.stopItem.isEnabled = canStop }
                if self.restartItem.isEnabled != canStop { self.restartItem.isEnabled = canStop }
                self.statusItem.button?.toolTip = "Print Chamber · " + label
                if Date() >= self.flashUntil {
                    self.stateItem.title = label
                    self.setIcon(state == "ready" ? "printer.fill" : (state == "busy" ? "hourglass" : "printer"), label)
                }
                if let message = response["message"] as? String { self.alert(message) }
                if action != "status" && ["error", "conflict"].contains(state) { self.alert(label) }
                if CommandLine.arguments.contains("--self-test") {
                    print("Menu ready: \(self.statusItem.menu!.items.count) items; \(label)")
                    NSApp.terminate(nil)
                }
                then?(state)
            }
        }
    }

    func alert(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert(); alert.messageText = "Print Chamber"; alert.informativeText = message
        alert.addButton(withTitle: "好"); alert.runModal()
    }
    @objc func startModel() { run("start") }
    @objc func stopModel() { run("stop") }
    @objc func restartModel() { run("restart") }
    @objc func copyToken() {
        guard let token = try? String(contentsOf: connectionTokenURL(project: root), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
            alert("首次使用请先启动模型，连接码会自动生成。"); return
        }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(token, forType: .string)
        flash("已复制插件连接码", symbol: "checkmark.circle")
    }
    @objc func openHelp() { NSWorkspace.shared.open(root.appendingPathComponent("菜单栏小助手说明.txt")) }
    @objc func openLog() {
        let path = root.appendingPathComponent(controllerFailed ? ".local/helper.log" : ".local/service.log")
        if FileManager.default.fileExists(atPath: path.path) { NSWorkspace.shared.open(path) }
        else { alert("暂无运行日志，请先启动模型。") }
    }
    @objc func openLink(_ sender: LinkButton) { if let url = sender.url { NSWorkspace.shared.open(url) } }

    @objc func quit() {
        guard runningStates.contains(state) else { NSApp.terminate(nil); return }
        let busy = state == "busy"
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "模型仍在后台运行"
        alert.informativeText = busy
            ? "正在生成图片，暂时不能停止模型。仅退出小助手时，模型会继续运行并占用内存。"
            : "退出小助手不会停止模型，模型会继续占用内存。是否一起停止？"
        if !busy { alert.addButton(withTitle: "停止模型并退出") }
        alert.addButton(withTitle: "仅退出小助手")
        alert.addButton(withTitle: "取消").keyEquivalent = "\u{1b}"
        let choice = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + (busy ? 1 : 0)
        if choice == 0 { run("stop") { if $0 == "stopped" { NSApp.terminate(nil) } } }
        else if choice == 1 { NSApp.terminate(nil) }
    }

    @objc func showAbout() {
        if aboutWindow == nil { aboutWindow = makeAboutWindow(); aboutWindow?.center() }
        NSApp.activate(ignoringOtherApps: true)
        aboutWindow?.makeKeyAndOrderFront(nil)
    }

    func renderAbout(to file: URL) {
        let window = makeAboutWindow(), view = window.contentView!
        if CommandLine.arguments.contains("--light") { window.appearance = NSAppearance(named: .aqua) }
        // The PNG has no window chrome, so paint the window background behind the labels.
        view.wantsLayer = true
        view.effectiveAppearance.performAsCurrentDrawingAppearance {
            view.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        }
        window.orderFrontRegardless(); window.displayIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        try? bitmap.representation(using: .png, properties: [:])?.write(to: file)
    }

    func makeAboutWindow() -> AboutWindow {
        let width: CGFloat = 360, inner = width - 48
        let window = AboutWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 600), styleMask: [.titled, .closable],
                                 backing: .buffered, defer: false)
        window.title = "关于 Print Chamber"
        window.isReleasedWhenClosed = false
        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: 80), icon.heightAnchor.constraint(equalToConstant: 80)])
        let versionText = text("菜单栏小助手 v\(version)", size: 12, color: .secondaryLabelColor)
        versionText.isSelectable = true
        let header = stack([icon, text("Print Chamber", size: 20, weight: .semibold), versionText,
                            text("让平面的灵感，多一个立体视角。", size: 12, color: .secondaryLabelColor)],
                           spacing: 4, alignment: .centerX)
        let sponsor = section("自愿赞助", "完全自愿，不影响任何功能。感谢你的支持！", inner)
        sponsor.addArrangedSubview(sponsorCodes())
        let content = stack([
            header, separator(),
            section("开源仓库", "源代码、使用说明与版本记录都在 GitHub 公开。", inner, link("在 GitHub 打开", repositoryURL)),
            section("反馈与建议", "遇到问题或有新想法，欢迎提交 Issue。", inner, link("提交反馈", issuesURL)),
            sponsor
        ], spacing: 18, alignment: .leading)
        content.edgeInsets = NSEdgeInsets(top: 22, left: 24, bottom: 24, right: 24)
        let container = NSView()
        container.addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        var constraints = [content.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                           content.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                           content.topAnchor.constraint(equalTo: container.topAnchor),
                           content.bottomAnchor.constraint(equalTo: container.bottomAnchor),
                           content.widthAnchor.constraint(equalToConstant: width)]
        constraints += content.arrangedSubviews.map { $0.widthAnchor.constraint(equalToConstant: inner) }
        NSLayoutConstraint.activate(constraints)
        window.contentView = container
        window.setContentSize(content.fittingSize)
        return window
    }

    func stack(_ views: [NSView], spacing: CGFloat, alignment: NSLayoutConstraint.Attribute) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical; stack.spacing = spacing; stack.alignment = alignment
        return stack
    }

    func text(_ value: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor,
              width: CGFloat? = nil) -> NSTextField {
        let field = width == nil ? NSTextField(labelWithString: value) : NSTextField(wrappingLabelWithString: value)
        field.font = .systemFont(ofSize: size, weight: weight); field.textColor = color
        if let width { field.preferredMaxLayoutWidth = width }
        return field
    }

    func separator() -> NSBox { let line = NSBox(); line.boxType = .separator; return line }

    func link(_ title: String, _ url: URL) -> LinkButton {
        let button = LinkButton(title: title, target: self, action: #selector(openLink(_:)))
        button.url = url; button.bezelStyle = .rounded
        button.toolTip = url.absoluteString
        return button
    }

    func section(_ title: String, _ detail: String, _ width: CGFloat, _ extra: NSView? = nil) -> NSStackView {
        let views: [NSView] = [text(title, size: 13, weight: .semibold),
                               text(detail, size: 12, color: .secondaryLabelColor, width: width)] + (extra.map { [$0] } ?? [])
        let section = stack(views, spacing: 6, alignment: .leading)
        section.setCustomSpacing(10, after: views[1])
        return section
    }

    // Payment codes are optional files dropped into menu-helper/sponsor/; nothing is fetched remotely.
    func sponsorCodes() -> NSView {
        let folder = root.appendingPathComponent("menu-helper/sponsor")
        let codes: [NSView] = [("wechat", "微信"), ("alipay", "支付宝")].compactMap { name, caption in
            guard let file = ["png", "jpg", "jpeg"].map({ folder.appendingPathComponent("\(name).\($0)") })
                    .first(where: { FileManager.default.fileExists(atPath: $0.path) }),
                  let image = NSImage(contentsOf: file) else { return nil }
            let view = NSImageView(image: image)
            view.imageScaling = .scaleProportionallyUpOrDown
            view.setAccessibilityLabel("\(caption)收款码")
            view.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([view.widthAnchor.constraint(equalToConstant: 132),
                                         view.heightAnchor.constraint(equalToConstant: 132)])
            return stack([view, text(caption, size: 11, color: .secondaryLabelColor)], spacing: 4, alignment: .centerX)
        }
        if codes.isEmpty { return text("收款码暂未添加。", size: 12, color: .tertiaryLabelColor) }
        let row = NSStackView(views: codes)
        row.orientation = .horizontal; row.spacing = 24; row.alignment = .top
        return row
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let helper = Helper()
app.delegate = helper
app.run()
