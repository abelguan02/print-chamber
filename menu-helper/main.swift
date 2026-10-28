import Cocoa

final class Helper: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let stateItem = NSMenuItem(title: "正在检查…", action: nil, keyEquivalent: "")
    var startItem: NSMenuItem!
    var stopItem: NSMenuItem!
    var timer: Timer?
    var pending = false
    var controllerFailed = false
    let root = URL(fileURLWithPath: Bundle.main.object(forInfoDictionaryKey: "ProjectRoot") as! String)

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Launch Services normally reuses the app; also guard direct binary launches.
        if NSRunningApplication.runningApplications(withBundleIdentifier: "local.printchamber.helper")
            .contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            NSApp.terminate(nil); return
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "printer", accessibilityDescription: "Print Chamber")
        statusItem.button?.image?.isTemplate = true
        let menu = NSMenu()
        menu.autoenablesItems = false
        let title = NSMenuItem(title: "Print Chamber · 本地模型", action: nil, keyEquivalent: "")
        title.isEnabled = false; menu.addItem(title)
        stateItem.isEnabled = false; menu.addItem(stateItem)
        menu.addItem(.separator())
        startItem = item("启动模型", #selector(startModel), menu)
        stopItem = item("停止模型", #selector(stopModel), menu)
        menu.addItem(.separator())
        item("复制插件连接码", #selector(copyToken), menu)
        item("打开使用说明", #selector(openHelp), menu)
        item("查看运行日志", #selector(openLog), menu)
        menu.addItem(.separator())
        let hint = NSMenuItem(title: "仅手动启动 · 不随登录加载模型", action: nil, keyEquivalent: "")
        hint.isEnabled = false; menu.addItem(hint)
        item("退出小助手（模型继续运行）", #selector(quit), menu)
        statusItem.menu = menu
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer!, forMode: .common)
    }

    @discardableResult func item(_ title: String, _ selector: Selector, _ menu: NSMenu) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        entry.target = self; menu.addItem(entry); return entry
    }

    func refresh() { run("status") }
    func run(_ action: String) {
        guard !pending else { return }
        pending = true
        startItem.isEnabled = false; stopItem.isEnabled = false
        if action != "status" { stateItem.title = action == "start" ? "正在启动…" : "正在停止…" }
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
                self.controllerFailed = state == "error"
                self.stateItem.title = response["label"] as? String ?? "状态未知"
                self.startItem.isEnabled = state == "stopped"
                self.stopItem.isEnabled = ["ready", "loading", "failed", "unreachable"].contains(state)
                self.statusItem.button?.toolTip = "Print Chamber · " + self.stateItem.title
                let symbol = state == "ready" ? "printer.fill" : (state == "busy" ? "hourglass" : "printer")
                self.statusItem.button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: self.stateItem.title)
                self.statusItem.button?.image?.isTemplate = true
                if let message = response["message"] as? String { self.alert(message) }
                if action != "status" && ["error", "conflict"].contains(state) { self.alert(self.stateItem.title) }
                if CommandLine.arguments.contains("--self-test") {
                    print("Menu ready: \(self.statusItem.menu!.items.count) items; \(self.stateItem.title)")
                    NSApp.terminate(nil)
                }
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
    @objc func copyToken() {
        guard let token = try? String(contentsOf: root.appendingPathComponent(".local/token"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
            alert("首次使用请先启动模型，连接码会自动生成。"); return
        }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(token, forType: .string)
    }
    @objc func openHelp() { NSWorkspace.shared.open(root.appendingPathComponent("菜单栏小助手说明.txt")) }
    @objc func openLog() {
        let path = root.appendingPathComponent(controllerFailed ? ".local/helper.log" : ".local/service.log")
        if FileManager.default.fileExists(atPath: path.path) { NSWorkspace.shared.open(path) }
        else { alert("暂无运行日志，请先启动模型。") }
    }
    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let helper = Helper()
app.delegate = helper
app.run()
