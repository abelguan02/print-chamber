// Appended to the production helper source in a temporary unsigned test bundle.
func require(_ condition: Bool, _ message: String) {
    if !condition { fputs(message + "\n", stderr); exit(1) }
}
func waitFor(_ condition: () -> Bool) {
    let deadline = Date().addingTimeInterval(20)
    while !condition() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    require(condition(), "timeout")
}
let env = ProcessInfo.processInfo.environment
let scenario = CommandLine.arguments[1]
let helper = Helper()
helper.installer = ModelInstaller(state: helper.paths.state, resources: helper.root,
    source: URL(string: env["FIXTURE_URL"]!)!, digest: env["FIXTURE_HASH"]!,
    capacity: { _ in scenario == "space" ? 19_999_999_999 : 30_000_000_000 })
try helper.prepareRuntime(registerHost: false)
let menu = helper.makeMenu(), grid = helper.makeSettingsGrid()
func controls(_ installed: Bool) {
    for item in [helper.startItem, helper.stopItem, helper.restartItem, helper.copyItem] {
        require(item!.isHidden != installed, "menu visibility")
    }
    require(helper.modelLabel.stringValue == (installed ? "已安装" : "未安装"), "model row: " + helper.modelLabel.stringValue)
    require(helper.modelAction.title == (installed ? "删除" : "下载（约 16 GB）"), "settings button")
}
if scenario == "timer" {
    controls(false)
    helper.startStatusTimer()
    let python = helper.installer.python, model = helper.installer.model
    try FileManager.default.createDirectory(at: python.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: python.path, withDestinationPath: env["FIXTURE_PYTHON"]!)
    try FileManager.default.createDirectory(at: model, withIntermediateDirectories: true)
    waitFor { helper.interpreter != nil && !helper.pending }
    controls(true)
    try FileManager.default.removeItem(at: model)
    waitFor { helper.interpreter == nil }
    controls(false)
    helper.timer?.invalidate()
} else if scenario == "space" {
    require(!helper.modelAction.isEnabled && helper.modelLabel.stringValue == "磁盘空间不足", "space not enforced")
    helper.beginInstall()
    waitFor { helper.modelJob == nil }
    require(!helper.installer.incomplete, "created a partial install with insufficient space")
} else if ["external", "delete", "busy"].contains(scenario) {
    controls(true)
    helper.removeModel()
    waitFor { helper.modelJob == nil && !helper.pending }
    if scenario == "busy" { require(helper.interpreter != nil && helper.installNotice == "模型未停止", "removed running model") }
    else { controls(false) }
} else {
    if scenario == "resume" { require(helper.modelAction.title == "继续", "missing resumable session") }
    let previous = helper.installer.progress?.downloaded ?? 0
    helper.beginInstall()
    if ["pause", "close", "quit"].contains(scenario) {
        waitFor { (helper.installer.progress?.downloaded ?? 0) > previous + 524288 }
        helper.updateModelControls()
        require(!helper.byteLabel.stringValue.isEmpty && helper.modelAction.title == "暂停", "missing progress")
        if scenario == "pause" { helper.modelActionClicked() }
        else if scenario == "close" {
            helper.refreshOpenSettings()
            let atClose = helper.modelProgress.doubleValue
            helper.windowWillClose(Notification(name: NSWindow.willCloseNotification))
            require(helper.settingsTimer == nil && !helper.pausing, "closing paused the download")
            waitFor { Double(helper.installer.progress?.downloaded ?? 0) > atClose }
            helper.refreshOpenSettings()
            require(helper.modelProgress.doubleValue > atClose && helper.modelAction.title == "暂停",
                    "reopened settings did not immediately show current progress")
            helper.windowWillClose(Notification(name: NSWindow.willCloseNotification))
        }
        else {
            var replied = false
            let answer = helper.finishBeforeQuit { replied = true }
            require(answer == .terminateLater, "did not wait for worker")
            waitFor { replied }
        }
    }
    waitFor { helper.modelJob == nil && !helper.pending }
    if ["pause","quit","bad","network","checksum"].contains(scenario) {
        require(helper.interpreter == nil && helper.modelAction.title == "继续", "partial model exposed")
        print(helper.modelLabel.stringValue)
    } else {
        controls(true)
        require(helper.startItem.isEnabled && helper.copyItem.isEnabled, "menu controls not enabled")
        if scenario == "roundtrip" {
            helper.removeModel()
            waitFor { helper.modelJob == nil && !helper.pending }
            controls(false)
        }
    }
}
print("ok")
