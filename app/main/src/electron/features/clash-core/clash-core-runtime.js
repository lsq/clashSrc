"use strict";

function createClashCoreRuntime({
    childProcess,
    fs,
    path,
    serviceApi,
    getSensitiveValues = () => [],
    logger = console,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
}) {
    function killProcess(processHandle, platform = process.platform) {
        const pid = processHandle && processHandle.pid;
        if (!pid) return;
        try {
            if (!Number.isSafeInteger(pid) || pid <= 0) return;
            if (platform === "win32") childProcess.execFileSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
            else processHandle.kill("SIGKILL");
        } catch (_error) {}
    }

    async function stop({ processHandle, lightweightMode, platform }) {
        if (processHandle) processHandle.cfwStopping = true; // 新增
        killProcess(processHandle, platform);
        if (!lightweightMode) {
            await serviceApi.stop().catch(() => {});
        }
    }

    async function getStatus(clashApi, timeout = 1000) {
        try {
            const response = await clashApi.getConfig({
                validateStatus: () => true,
                timeout
            });
            const hasMixedPort = response.data
                && Object.prototype.hasOwnProperty.call(response.data, "mixed-port");
            return {
                connected: response.status === 200,
                mixedPort: hasMixedPort ? response.data["mixed-port"] : -1
            };
        } catch (_error) {
            return { connected: false, mixedPort: -1 };
        }
    }

    async function start({
        clashPath,
        binaryPath,
        coreType,
        logLevel,
        isLocalMode,
        portableMode,
        devMode,
        lightweightMode,
        clashApi,
        startupErrorMessage,
        onLogFile,
        onCoreReady,
        onServiceFallback
    }) {
        logger.info("restarting clash core...");
        const logPath = path.join(clashPath, "logs", createLogName());
        removeExpiredLogs(path.join(clashPath, "logs"));

        if (lightweightMode && (await getStatus(clashApi)).connected) {
            return { processHandle: null, skipped: true };
        }

        if (!isLocalMode) {
            let response = null;
            let startRequestFailed = false;
            try {
                response = await serviceApi.start({
                    path: devMode ? path.join(process.cwd(), binaryPath) : binaryPath,
                    cwd: clashPath,
                    silent: logLevel === "silent",
                    redactValues: getSensitiveValues().filter(value => typeof value === "string" && value.length > 0)
                });
            } catch (_error) {
                // Process creation can outlive the HTTP request (for example
                // while Windows scans a newly installed binary). Check the Core
                // API before falling back and starting a duplicate local core.
                startRequestFailed = true;
            }
            if (startRequestFailed || response.status === 200) {
                if (response && response.data) onLogFile(response.data);
                // A helper can acknowledge /start even when the selected core
                // reads the wrong home or exits immediately. Require its API to
                // become reachable before reporting Service Mode as successful.
                for (let attempt = 0; attempt < 15; attempt += 1) {
                    if ((await getStatus(clashApi, 150)).connected) {
                        await onCoreReady();
                        return { processHandle: null, serviceMode: true };
                    }
                    if (attempt < 14) await sleep(100);
                }
            }
            logger.info("fail to spawn in service mode, fallback to local mode");
            await serviceApi.stop().catch(() => {});
            await onServiceFallback();
            return { processHandle: null, fallback: true };
        }

        // Always pass the data directory. In Service Mode the process runs as a
        // system account, whose default ~/.config/clash is not the user's CFW data.
        const args = ["-d", clashPath];
        const processHandle = childProcess.spawn(binaryPath, args, {
            cwd: path.dirname(binaryPath),
            windowsHide: true,
            shell: false,
            detached: false,
            stdio: ["ignore", "pipe", "pipe"]
        });
        let readyNotified = false;
        const handleOutput = async output => {
            const text = output.toString();
            if (!readyNotified && /\[API\].*listening addr=|RESTful API listening at:/i.test(text)) {
                readyNotified = true;
                logger.info("clash core startup success!");
                await onCoreReady();
            }
            // 修复日志有ERR字样的误报
            if (!readyNotified && /ERR|level=error/i.test(text)) logger.error(startupErrorMessage);
        };
        processHandle.stdout.on("data", handleOutput);
        processHandle.stderr.on("data", handleOutput);
        // stop() 里 kill 之前：stopping = true;
        processHandle.on("exit", (code, signal) => {
            if (!readyNotified) {
                logger.error(`${startupErrorMessage} (exit code=${code}, signal=${signal})`);
            } else if (!processHandle.cfwStopping) {
                logger.error(`clash core exited unexpectedly (code=${code}, signal=${signal})`);
            }
        });
        processHandle.on("error", () => logger.error(startupErrorMessage));

        if (logLevel !== "silent") {
            const stream = fs.createWriteStream(logPath, { flags: "a" });
            // Never let file backpressure pause stdout/stderr: a paused pipe lets the
            // OS pipe fill, which blocks the core's stdout write while it holds the
            // logrus mutex and deadlocks the whole core. Drop chunks instead once the
            // buffered backlog exceeds the cap.
            const MAX_BUFFERED = 4 * 1024 * 1024; // 4MB
            let droppedBytes = 0;
            const writeLog = chunk => {
                if (stream.writableLength > MAX_BUFFERED) {
                    droppedBytes += chunk.length;
                    return;
                }
                if (droppedBytes > 0) {
                    stream.write(`\n[CFW] ${droppedBytes} bytes of core log dropped (disk too slow)\n`);
                    droppedBytes = 0;
                }
                stream.write(chunk);
            };
            processHandle.stdout.on("data", writeLog);
            processHandle.stderr.on("data", writeLog);
            processHandle.on("exit", () => stream.end());
            onLogFile(logPath);
        }
        return { processHandle, serviceMode: false };
    }

    function removeExpiredLogs(logDirectory) {
        fs.readdir(logDirectory, (error, files) => {
            if (error || !files) return;
            for (const file of files) {
                // Service helpers append a unique suffix to avoid log collisions.
                const match = file.match(/^(\d{4}-\d{2}-\d{2}-\d{6})(?:-[a-fA-F0-9-]{1,64})?\.log$/);
                if (!match) continue;
                const timestamp = parseLogTimestamp(match[1]);
                if (timestamp && Date.now() - timestamp > 7 * 24 * 60 * 60 * 1000) {
                    fs.unlink(path.join(logDirectory, file), () => {});
                }
            }
        });
    }

    function createLogName(now = new Date()) {
        const pad = value => String(value).padStart(2, "0");
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-`
            + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.log`;
    }

    function parseLogTimestamp(value) {
        const match = value.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/);
        if (!match) return 0;
        return new Date(
            Number(match[1]), Number(match[2]) - 1, Number(match[3]),
            Number(match[4]), Number(match[5]), Number(match[6])
        ).getTime();
    }

    return { killProcess, stop, getStatus, start };
}

module.exports = { createClashCoreRuntime };
