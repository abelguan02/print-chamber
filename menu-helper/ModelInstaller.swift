import Foundation
import CryptoKit

struct InstallError: LocalizedError {
    let message: String
    var exitCode: Int32?
    init(_ message: String, exitCode: Int32? = nil) { self.message = message; self.exitCode = exitCode }
    var errorDescription: String? { message }
}

struct ModelProgress: Codable {
    let downloaded: Int64
    let total: Int64
}

final class ModelInstaller {
    static let uvRelease = URL(string: "https://github.com/astral-sh/uv/releases/download/0.13.9/uv-aarch64-apple-darwin.tar.gz")!
    // Official companion .sha256 for the archive above.
    static let uvDigest = "5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca"
    static let minimumSpace: Int64 = 20_000_000_000
    let state: URL
    let resources: URL
    let work: URL
    let source: URL
    let digest: String
    let capacity: (URL) throws -> Int64
    let fm = FileManager.default
    private let lock = NSLock()
    private var child: Process?
    private var paused = false

    init(state: URL, resources: URL, source: URL = ModelInstaller.uvRelease, digest: String = ModelInstaller.uvDigest,
         capacity: @escaping (URL) throws -> Int64 = { url in
             let v = try url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
             guard let bytes = v.volumeAvailableCapacityForImportantUsage else { throw InstallError("无法读取磁盘空间") }
             return bytes
         }) {
        self.state = state; self.resources = resources; self.source = source; self.digest = digest
        self.work = state.appendingPathComponent("model-installer")
        self.capacity = capacity
    }

    var marker: URL { work.appendingPathComponent("pending") }
    var incomplete: Bool { fm.fileExists(atPath: marker.path) }
    var model: URL { state.appendingPathComponent("models/FLUX.2-klein-4B") }
    var python: URL { state.appendingPathComponent("python/bin/python") }
    var removalMarker: URL { state.appendingPathComponent(".model-removal-pending") }
    var removing: Bool { fm.fileExists(atPath: removalMarker.path) }
    var progress: ModelProgress? {
        guard let data = try? Data(contentsOf: work.appendingPathComponent("progress.json")) else { return nil }
        return try? JSONDecoder().decode(ModelProgress.self, from: data)
    }

    func resume() { lock.lock(); paused = false; lock.unlock() }
    func pause() {
        lock.lock(); defer { lock.unlock() }
        paused = true
        if let task = child, task.isRunning {
            let pid = task.processIdentifier
            kill(getpgid(pid) == pid ? -pid : pid, SIGTERM)
        }
    }
    private func checkPause() throws {
        lock.lock(); defer { lock.unlock() }
        if paused { throw InstallError("已暂停") }
    }

    private func run(_ executable: URL, _ args: [String], error: String, output: URL? = nil) throws {
        let p = Process()
        p.executableURL = executable; p.arguments = args
        p.currentDirectoryURL = work
        let home = work.appendingPathComponent("home").path
        p.environment = ["HOME": home, "PATH": "/usr/bin:/bin", "TMPDIR": work.appendingPathComponent("tmp").path,
                         "UV_PYTHON_INSTALL_DIR": work.appendingPathComponent("managed-python").path,
                         "UV_PYTHON_BIN_DIR": home + "/bin", "UV_CACHE_DIR": work.appendingPathComponent("uv-cache").path,
                         "UV_NO_CONFIG": "1", "UV_MANAGED_PYTHON": "1", "UV_NO_MODIFY_PATH": "1",
                         "HF_HOME": home + "/hub", "HF_HUB_DISABLE_XET": "1", "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
                         "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"]
        p.standardInput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        var handle: FileHandle?
        if let output {
            try Data().write(to: output)
            handle = try FileHandle(forWritingTo: output)
        }
        defer { try? handle?.close() }
        p.standardOutput = handle ?? FileHandle.nullDevice
        lock.lock()
        do {
            guard !paused else { throw InstallError("已暂停") }
            try p.run(); child = p; lock.unlock()
        } catch { lock.unlock(); throw error }
        p.waitUntilExit()
        lock.lock(); child = nil; lock.unlock()
        try checkPause()
        guard p.terminationStatus == 0 else { throw InstallError(error, exitCode: p.terminationStatus) }
    }

    private func config() throws -> [String: Any] {
        let url = state.appendingPathComponent("runtime.json")
        guard fm.fileExists(atPath: url.path) else { return [:] }
        guard let data = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        else { throw InstallError("运行配置无效") }
        return data
    }
    private func writeConfig(_ value: [String: Any]) throws {
        try JSONSerialization.data(withJSONObject: value, options: .prettyPrinted)
            .write(to: state.appendingPathComponent("runtime.json"), options: .atomic)
    }
    private func step(_ name: String, _ perform: () throws -> Void) throws {
        try checkPause()
        let done = work.appendingPathComponent(name + ".done")
        if !fm.fileExists(atPath: done.path) {
            try perform()
            try Data().write(to: done, options: .atomic)
        }
    }

    func install(notify: (String) -> Void) throws {
        guard !removing else { throw InstallError("删除未完成") }
        _ = try config() // Fail before writing into a damaged configuration.
        guard try capacity(state) >= Self.minimumSpace else { throw InstallError("磁盘空间不足") }
        for url in [work, state.appendingPathComponent("python"), state.appendingPathComponent("models")] {
            if (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
                throw InstallError("安装目录为符号链接")
            }
        }
        if !incomplete && fm.fileExists(atPath: model.path) { throw InstallError("模型目录已存在 · 请检查配置") }
        for dir in [work, work.appendingPathComponent("tmp"), work.appendingPathComponent("home")] {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        if !incomplete {
            // Completion markers apply only to one install, even if its runtime was later removed.
            for name in ["uv", "python", "venv", "dependencies", "snapshot"] {
                let done = work.appendingPathComponent(name + ".done")
                if fm.fileExists(atPath: done.path) { try fm.removeItem(at: done) }
            }
            try Data().write(to: marker, options: .atomic)
        }
        let archive = work.appendingPathComponent("uv.tar.gz")
        let uv = work.appendingPathComponent("uv")
        notify("下载 uv")
        try step("uv") {
            func verifiedArchive() throws -> Bool {
                guard fm.fileExists(atPath: archive.path) else { return false }
                let bytes = try Data(contentsOf: archive, options: .mappedIfSafe)
                return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() == digest
            }
            if try !verifiedArchive() {
                let curl = URL(fileURLWithPath: "/usr/bin/curl")
                let args = ["-q", "--fail", "--silent", "--show-error", "--location", "--connect-timeout", "20",
                            "--speed-limit", "1", "--speed-time", "60", "-o", archive.path]
                do {
                    try run(curl, args + ["-C", "-", source.absoluteString], error: "uv 下载中断 · 可继续")
                } catch let error as InstallError where error.exitCode == 33 {
                    // A mirror may ignore Range; restart only this unfinished archive.
                    try run(curl, args + [source.absoluteString], error: "uv 下载中断 · 可继续")
                }
                guard try verifiedArchive() else {
                    try fm.removeItem(at: archive)
                    throw InstallError("uv 校验失败")
                }
            }
            try run(URL(fileURLWithPath: "/usr/bin/tar"), ["-xzOf", archive.path, "uv-aarch64-apple-darwin/uv"],
                    error: "uv 解包失败", output: uv)
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: uv.path)
        }
        notify("安装 Python 3.12.14")
        try step("python") { try run(uv, ["python", "install", "3.12.14"], error: "Python 安装失败 · 可继续") }
        try step("venv") {
            try run(uv, ["venv", "--python", "3.12.14", "--allow-existing", state.appendingPathComponent("python").path],
                    error: "Python 环境创建失败 · 可继续")
        }
        notify("安装依赖")
        try step("dependencies") {
            try run(uv, ["pip", "install", "--python", python.path, "-r",
                         resources.appendingPathComponent("requirements-macos-arm64.txt").path, "--only-binary", ":all:"], error: "依赖安装失败 · 可继续")
        }
        let staging = work.appendingPathComponent("snapshot")
        notify("下载模型")
        try step("snapshot") {
            try fm.createDirectory(at: staging, withIntermediateDirectories: true)
            try run(python, [resources.appendingPathComponent("installer/local_model.py").path,
                             staging.path, work.appendingPathComponent("progress.json").path], error: "模型下载中断 · 可继续")
            guard fm.fileExists(atPath: staging.appendingPathComponent("LICENSE.md").path),
                  fm.fileExists(atPath: staging.appendingPathComponent("model_index.json").path)
            else { throw InstallError("模型文件不完整 · 可继续") }
        }
        try checkPause()
        try fm.createDirectory(at: model.deletingLastPathComponent(), withIntermediateDirectories: true)
        if fm.fileExists(atPath: staging.path) { try fm.moveItem(at: staging, to: model) }
        var saved = try config()
        saved["python"] = python.path; saved["model"] = model.path
        try writeConfig(saved)
        try fm.removeItem(at: marker)
    }

    // A durable intent allows a confirmed, interrupted removal to be retried.
    func remove() throws {
        _ = try config()
        try Data().write(to: removalMarker, options: .atomic)
        for name in ["python", "models", work.lastPathComponent] {
            let owned = state.appendingPathComponent(name)
            do { try fm.removeItem(at: owned) }
            catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileNoSuchFileError { continue }
        }
        var saved = try config()
        saved.removeValue(forKey: "python"); saved.removeValue(forKey: "model")
        try writeConfig(saved)
        try fm.removeItem(at: removalMarker)
    }
}
