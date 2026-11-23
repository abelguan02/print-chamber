import Cocoa

func stateDirectory(project: URL, appMode: Bool, environment: [String: String]) -> URL {
    let fallback = appMode ? FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Print Chamber") : project.appendingPathComponent(".local")
    let directory = environment["PRINT_CHAMBER_STATE"].map {
        URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath)
    } ?? fallback
    return directory.standardizedFileURL.resolvingSymlinksInPath()
}

struct RuntimePaths {
    let appMode: Bool
    let root: URL
    let state: URL
    let controller: URL
    let help: URL
    let environment = ProcessInfo.processInfo.environment

    init(bundle: Bundle = .main) {
        appMode = bundle.object(forInfoDictionaryKey: "PrintChamberMode") as? String == "app"
        if appMode {
            root = bundle.resourceURL!
        } else {
            root = URL(fileURLWithPath: bundle.object(forInfoDictionaryKey: "ProjectRoot") as! String)
        }
        state = stateDirectory(project: root, appMode: appMode, environment: environment)
        controller = root.appendingPathComponent(appMode ? "controller.py" : "menu-helper/controller.py")
        help = root.appendingPathComponent(appMode ? "使用说明.txt" : "菜单栏小助手说明.txt")
    }

    var childEnvironment: [String: String] {
        var env = environment
        env["PRINT_CHAMBER_MODE"] = appMode ? "app" : "dev"
        env["PRINT_CHAMBER_STATE"] = state.path
        if appMode { env["PYTHONDONTWRITEBYTECODE"] = "1" }
        return env
    }

    func controllerInterpreter() throws -> URL? {
        struct Config: Decodable { var python: String?; var model: String? }
        let fm = FileManager.default
        let file = state.appendingPathComponent("runtime.json")
        let config = fm.fileExists(atPath: file.path)
            ? try JSONDecoder().decode(Config.self, from: Data(contentsOf: file)) : Config()
        func setting(_ key: String, _ saved: String?, _ fallback: URL) -> URL {
            guard let path = [environment[key], saved].compactMap({ $0 }).first(where: { !$0.isEmpty })
            else { return fallback }
            return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        }
        let python = setting("FLUX_PYTHON", config.python, appMode
            ? state.appendingPathComponent("python/bin/python") : root.appendingPathComponent(".venv/bin/python"))
        var directory: ObjCBool = false
        guard fm.fileExists(atPath: python.path, isDirectory: &directory), !directory.boolValue,
              fm.isExecutableFile(atPath: python.path) else { return nil }
        if appMode {
            // On a clean Mac this executable opens the command-line tools installer.
            guard python.resolvingSymlinksInPath().path != "/usr/bin/python3" else { return nil }
            let model = setting("FLUX_MODEL_PATH", config.model, state.appendingPathComponent("models/FLUX.2-klein-4B"))
            guard fm.fileExists(atPath: model.path, isDirectory: &directory), directory.boolValue else { return nil }
        }
        return python  // Preserve the venv executable path, including its symlink.
    }

    func runNode(_ arguments: [String]) throws -> Data {
        let process = Process(), output = Pipe()
        process.executableURL = root.appendingPathComponent("node/bin/node")
        process.arguments = arguments
        process.environment = childEnvironment
        process.standardOutput = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw CocoaError(.executableRuntimeMismatch) }
        return data
    }

    var extensionStatus: String {
        struct Seen: Decodable { let version: String }
        let file = state.appendingPathComponent("extension-seen.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return "未加载" }
        do {
            let seen = try JSONDecoder().decode(Seen.self, from: Data(contentsOf: file))
            return "已连接 · v" + seen.version
        } catch { return "配对记录无效" }
    }

    func prepare() throws {
        guard appMode else { return }
        let fm = FileManager.default
        try fm.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: state.path)
        try syncExtension(from: root.appendingPathComponent("extension"), to: state.appendingPathComponent("extension"))
    }
}

// Only this application-owned subtree is mirrored. Replace links themselves, never their targets.
func syncExtension(from source: URL, to destination: URL) throws {
    let fm = FileManager.default
    func type(_ url: URL) throws -> FileAttributeType? {
        do { return try fm.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType }
        catch let error as NSError where error.domain == NSCocoaErrorDomain &&
            error.code == NSFileReadNoSuchFileError { return nil }
    }
    let existing = try type(destination)
    switch try type(source) {
    case .typeDirectory:
        let names = try fm.contentsOfDirectory(atPath: source.path)
        if existing != .typeDirectory {
            if existing != nil { try fm.removeItem(at: destination) }
            try fm.createDirectory(at: destination, withIntermediateDirectories: false)
        }
        for name in names {
            try syncExtension(from: source.appendingPathComponent(name), to: destination.appendingPathComponent(name))
        }
        for name in Set(try fm.contentsOfDirectory(atPath: destination.path)).subtracting(names) {
            try fm.removeItem(at: destination.appendingPathComponent(name))
        }
    case .typeRegular:
        if existing == .typeRegular && fm.contentsEqual(atPath: source.path, andPath: destination.path) { return }
        if existing != nil && existing != .typeRegular { try fm.removeItem(at: destination) }
        try Data(contentsOf: source).write(to: destination, options: .atomic)
    default: throw CocoaError(.fileReadUnsupportedScheme)
    }
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

final class Helper: NSObject, NSApplicationDelegate, NSWindowDelegate {
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
    let paths = RuntimePaths()
    var root: URL { paths.root }
    var interpreter: URL?
    var missingLabel = "本地模型未安装"
    var settingsWindow: NSWindow?
    var settingsTimer: Timer?
    lazy var installer = ModelInstaller(state: paths.state, resources: root)
    enum ModelJob { case install, remove }
    var modelJob: ModelJob?
    var installNotice: String?
    var pausing = false
    var replyWhenIdle: (() -> Void)?
    let modelLabel = NSTextField(labelWithString: "未安装")
    let modelAction = NSButton()
    let modelProgress = NSProgressIndicator()
    let byteLabel = NSTextField(labelWithString: "")
    var progressView: NSStackView?
    let extensionLabel = NSTextField(labelWithString: "未加载")
    let codexLabel = NSTextField(labelWithString: "检测中…")
    var detectingCodex = false
    let chromeURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome")
    var copyItem: NSMenuItem!
    var controllerStarts = 0
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "未知"

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let index = CommandLine.arguments.firstIndex(of: "--render-about"), index + 1 < CommandLine.arguments.count {
            renderAbout(to: URL(fileURLWithPath: CommandLine.arguments[index + 1])); NSApp.terminate(nil); return
        }
        // Launch Services normally reuses the app; also guard direct binary launches.
        if let identifier = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
            .contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            NSApp.terminate(nil); return
        }
        do { try prepareRuntime(registerHost: true) }
        catch { alert("初始化失败 · " + error.localizedDescription); NSApp.terminate(nil); return }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        setIcon("printer", "Print Chamber")
        statusItem.menu = makeMenu()
        refresh()
        if paths.appMode {
            let firstLaunch = paths.state.appendingPathComponent("settings-opened")
            if !FileManager.default.fileExists(atPath: firstLaunch.path) {
                showSettings()
                do { try Data().write(to: firstLaunch, options: .atomic) }
                catch { alert("无法保存首次启动状态") }
            }
        }
        startStatusTimer()
    }

    func startStatusTimer() {
        if paths.appMode || interpreter != nil {
            timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
            RunLoop.main.add(timer!, forMode: .common)
        }
    }

    func prepareRuntime(registerHost: Bool) throws {
        try paths.prepare()
        if paths.appMode && registerHost {
            _ = try paths.runNode([root.appendingPathComponent("native/install.cjs").path, "--app"])
        }
        inspectRuntime()
    }

    func inspectRuntime() {
        missingLabel = "本地模型未安装"
        do { interpreter = paths.appMode && (installer.incomplete || modelJob == .install) ? nil : try paths.controllerInterpreter() }
        catch { interpreter = nil; missingLabel = "运行配置无效" }
    }

    func makeMenu() -> NSMenu {
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
        if !paths.appMode {
            let hint = NSMenuItem(title: "仅手动启动 · 不随登录加载模型", action: nil, keyEquivalent: "")
            hint.isEnabled = false; menu.addItem(hint)
        }
        menu.addItem(.separator())
        copyItem = item("复制插件连接码", #selector(copyToken), menu)
        for entry in [startItem, stopItem, restartItem, copyItem] { entry?.isHidden = interpreter == nil }
        if paths.appMode { item("设置…", #selector(showSettings), menu) }
        item("打开使用说明", #selector(openHelp), menu)
        item("查看运行日志", #selector(openLog), menu)
        menu.addItem(.separator())
        item("关于 Print Chamber…", #selector(showAbout), menu)
        item("退出小助手…", #selector(quit), menu)
        return menu
    }

    @discardableResult func item(_ title: String, _ selector: Selector, _ menu: NSMenu) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        entry.target = self; menu.addItem(entry); return entry
    }

    func setIcon(_ symbol: String, _ description: String) {
        statusItem?.button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: description)
        statusItem?.button?.image?.isTemplate = true
    }

    // Briefly confirm a silent action in the menu bar itself, since the menu closes on click.
    func flash(_ text: String, symbol: String) {
        flashUntil = Date().addingTimeInterval(2)
        stateItem.title = text; setIcon(symbol, text)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.1) { self.refresh() }
    }

    func refresh() {
        guard modelJob != .remove else { return }
        inspectRuntime()
        updateModelControls()
        run("status")
    }
    func run(_ action: String, then: ((String) -> Void)? = nil) {
        if modelJob == .remove && ["start", "restart"].contains(action) { return }
        guard let python = interpreter else {
            stateItem.title = missingLabel
            state = "uninstalled"
            then?(state)
            return
        }
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
        let paths = self.paths
        controllerStarts += 1
        DispatchQueue.global(qos: .utility).async {
            let process = Process(), pipe = Pipe()
            process.executableURL = python
            process.environment = paths.childEnvironment
            process.arguments = [paths.controller.path, action]
            process.standardOutput = pipe
            let logURL = paths.state.appendingPathComponent("helper.log")
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
                self.statusItem?.button?.toolTip = "Print Chamber · " + label
                if Date() >= self.flashUntil {
                    self.stateItem.title = label
                    self.setIcon(state == "ready" ? "printer.fill" : (state == "busy" ? "hourglass" : "printer"), label)
                }
                if let message = response["message"] as? String { self.alert(message) }
                if action != "status" && ["error", "conflict"].contains(state) { self.alert(label) }
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
        guard let token = try? String(contentsOf: paths.state.appendingPathComponent("token"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
            alert("首次使用请先启动模型，连接码会自动生成。"); return
        }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(token, forType: .string)
        flash("已复制插件连接码", symbol: "checkmark.circle")
    }
    func updateModelControls() {
        let installed = interpreter != nil
        for item in [startItem, stopItem, restartItem, copyItem] {
            item?.isHidden = !installed || (paths.appMode && installer.removing)
            if modelJob == .remove { item?.isEnabled = false }
        }
        copyItem?.isEnabled = installed && modelJob != .remove
        guard paths.appMode else { return }
        let enoughSpace = ((try? installer.capacity(paths.state)) ?? 0) >= ModelInstaller.minimumSpace
        modelAction.isEnabled = true
        if modelJob == .remove {
            modelLabel.stringValue = "正在删除"
            modelAction.title = "删除"; modelAction.isEnabled = false
        } else if modelJob == .install {
            modelLabel.stringValue = pausing ? "正在暂停" : installNotice ?? "准备中"
            modelAction.title = "暂停"; modelAction.isEnabled = !pausing
        } else if installer.removing {
            modelLabel.stringValue = "删除未完成"; modelAction.title = "删除"
        } else if installed {
            modelLabel.stringValue = installNotice ?? "已安装"; modelAction.title = "删除"
        } else {
            modelLabel.stringValue = enoughSpace ? installNotice ?? (installer.incomplete ? "已暂停" : "未安装") : "磁盘空间不足"
            modelAction.title = installer.incomplete ? "继续" : "下载（约 16 GB）"
            modelAction.isEnabled = enoughSpace
        }
        let active = modelJob == .install || installer.incomplete
        progressView?.isHidden = !active
        if active {
            let progress = installer.progress
            modelProgress.isIndeterminate = progress == nil
            if let p = progress {
                modelProgress.maxValue = Double(p.total)
                modelProgress.doubleValue = Double(p.downloaded)
                let formatter = ByteCountFormatter()
                byteLabel.stringValue = formatter.string(fromByteCount: p.downloaded) + " / " + formatter.string(fromByteCount: p.total)
            } else { byteLabel.stringValue = "0 B / 待计算"; modelProgress.startAnimation(nil) }
        }
    }

    @objc func modelActionClicked() {
        if modelJob == .install { pauseInstall(); return }
        guard modelJob == nil else { return }
        if interpreter == nil && !installer.removing { beginInstall(); return }
        let confirm = NSAlert()
        confirm.messageText = "删除本地模型？"
        confirm.addButton(withTitle: "取消")
        confirm.addButton(withTitle: "删除")
        if confirm.runModal() == .alertSecondButtonReturn { removeModel() }
    }

    func beginInstall() {
        guard modelJob == nil, interpreter == nil else { return }
        modelJob = .install; installNotice = "准备中"; pausing = false
        installer.resume()
        updateModelControls()
        let engine = installer
        DispatchQueue.global(qos: .utility).async {
            do {
                try engine.install { stage in
                    DispatchQueue.main.async { self.installNotice = stage; self.updateModelControls() }
                }
                DispatchQueue.main.async { self.finishModelJob(nil) }
            } catch { DispatchQueue.main.async { self.finishModelJob((error as? InstallError)?.message ?? "安装文件写入失败 · 可继续") } }
        }
    }

    func pauseInstall() {
        guard modelJob == .install else { return }
        pausing = true
        installer.pause()
        updateModelControls()
    }

    func removeModel() {
        guard modelJob == nil, interpreter != nil || installer.removing else { return }
        modelJob = .remove
        updateModelControls()
        func deleteFiles() {
            let engine = installer
            DispatchQueue.global(qos: .utility).async {
                do {
                    try engine.remove()
                    DispatchQueue.main.async { self.finishModelJob(nil) }
                } catch { DispatchQueue.main.async { self.finishModelJob("删除失败 · 可重试") } }
            }
        }
        if interpreter == nil { deleteFiles(); return } // Resume a removal that already stopped the service.
        run("stop") { result in
            if result == "stopped" { deleteFiles() }
            else { self.finishModelJob("模型未停止") }
        }
    }

    func finishModelJob(_ notice: String?) {
        modelJob = nil; pausing = false; installNotice = notice
        refresh()
        let reply = replyWhenIdle
        replyWhenIdle = nil
        reply?()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        finishBeforeQuit { sender.reply(toApplicationShouldTerminate: true) }
    }

    func finishBeforeQuit(_ reply: @escaping () -> Void) -> NSApplication.TerminateReply {
        guard modelJob != nil else { return .terminateNow }
        replyWhenIdle = reply
        pauseInstall()
        return .terminateLater
    }

    func makeSettingsGrid() -> NSGridView {
        modelAction.target = self
        modelAction.action = #selector(modelActionClicked)
        modelAction.bezelStyle = .rounded
        modelProgress.style = .bar
        modelProgress.widthAnchor.constraint(equalToConstant: 124).isActive = true
        byteLabel.font = .systemFont(ofSize: 11)
        let progress = NSStackView(views: [modelProgress, byteLabel])
        progress.orientation = .vertical
        progressView = progress
        updateModelControls()
        extensionLabel.stringValue = paths.extensionStatus
        let reveal = NSButton(title: "在访达中显示", target: self, action: #selector(revealExtension))
        let openChrome = NSButton(title: chromeURL == nil ? "未安装 Chrome" : "打开扩展页",
                                  target: self, action: #selector(openExtensions))
        openChrome.isEnabled = chromeURL != nil
        let grid = NSGridView(views: [
            [NSTextField(labelWithString: "Chrome 扩展"), extensionLabel, reveal, openChrome],
            [NSTextField(labelWithString: "本地模型"), modelLabel, progress, modelAction],
            [NSTextField(labelWithString: "本机 Codex"), codexLabel]
        ])
        grid.mergeCells(inHorizontalRange: NSRange(location: 1, length: 3), verticalRange: NSRange(location: 2, length: 1))
        grid.rowSpacing = 14
        grid.columnSpacing = 12
        grid.rowAlignment = .firstBaseline
        grid.translatesAutoresizingMaskIntoConstraints = false
        return grid
    }
    @objc func showSettings() {
        if settingsWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 182),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "设置"
            window.isReleasedWhenClosed = false
            window.delegate = self
            let grid = makeSettingsGrid()
            let content = window.contentView!
            content.addSubview(grid)
            NSLayoutConstraint.activate([grid.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
                                         grid.centerYAnchor.constraint(equalTo: content.centerYAnchor)])
            window.center()
            settingsWindow = window
        }
        extensionLabel.stringValue = paths.extensionStatus
        if settingsTimer == nil {
            settingsTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                guard let self else { return }
                self.extensionLabel.stringValue = self.paths.extensionStatus
                self.updateModelControls()
            }
        }
        if !detectingCodex {
            detectingCodex = true
            let paths = self.paths
            DispatchQueue.global(qos: .utility).async {
                struct Detection: Decodable { let found: Bool; let source: String?; let version: String? }
                let label: String
                do {
                    let data = try paths.runNode([paths.root.appendingPathComponent("native/detect.cjs").path])
                    let result = try JSONDecoder().decode(Detection.self, from: data)
                    if result.found, let version = result.version?.split(separator: " ").last {
                        label = "已检测到 · " + (result.source == "standalone" ? "独立版 " : "桌面版 ") + version
                    } else { label = "未检测到" }
                } catch { label = "检测失败" }
                DispatchQueue.main.async { self.codexLabel.stringValue = label; self.detectingCodex = false }
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }
    func windowWillClose(_ notification: Notification) {
        pauseInstall()
        settingsTimer?.invalidate()
        settingsTimer = nil
    }
    @objc func revealExtension() {
        NSWorkspace.shared.activateFileViewerSelecting([paths.state.appendingPathComponent("extension")])
    }
    @objc func openExtensions() {
        guard let chrome = chromeURL else { return }
        NSWorkspace.shared.open([URL(string: "chrome://extensions")!], withApplicationAt: chrome,
                                configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if error != nil { DispatchQueue.main.async { self.alert("无法打开 Chrome 扩展页") } }
        }
    }
    @objc func openHelp() { NSWorkspace.shared.open(paths.help) }
    @objc func openLog() {
        let path = paths.state.appendingPathComponent(controllerFailed ? "helper.log" : "service.log")
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

// Exercise the packaged startup paths and menu without installing a status-bar item.
if CommandLine.arguments.contains("--self-test") {
    do {
        let helper = Helper()
        let register = CommandLine.arguments.contains("--test-registration")
        if register {
            let fixtureHome = ProcessInfo.processInfo.environment["HOME"].map { URL(fileURLWithPath: $0).standardizedFileURL.resolvingSymlinksInPath().path }
            guard let fixtureHome, fixtureHome.hasPrefix(FileManager.default.temporaryDirectory.resolvingSymlinksInPath().path + "/")
                || fixtureHome.hasPrefix("/private/tmp/") else { throw CocoaError(.fileWriteNoPermission) }
        }
        try helper.prepareRuntime(registerHost: register)
        let menu = helper.makeMenu()
        helper.refresh()
        while helper.pending { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        var report: [String: Any] = [
            "mode": helper.paths.appMode ? "app" : "dev", "resources": helper.root.path,
            "state": helper.paths.state.path, "controller": helper.paths.controller.path,
            "python": helper.interpreter?.path as Any, "help": helper.paths.help.path,
            "menu": menu.items.filter { !$0.isHidden && !$0.isSeparatorItem }.map { $0.title },
            "extensionStatus": helper.paths.extensionStatus, "controllerStarts": helper.controllerStarts
        ]
        if helper.paths.appMode {
            let grid = helper.makeSettingsGrid()
            report["settingsRows"] = (0..<grid.numberOfRows).map { row in
                (0..<grid.numberOfColumns).compactMap { col in
                    let view = grid.cell(atColumnIndex: col, rowIndex: row).contentView
                    return (view as? NSTextField)?.stringValue ?? (view as? NSButton)?.title
                }
            }
        }
        print(String(decoding: try JSONSerialization.data(withJSONObject: report), as: UTF8.self))
        exit(0)
    } catch { fputs("Startup self-test failed: \(error)\n", stderr); exit(1) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let helper = Helper()
app.delegate = helper
app.run()
