"use strict";

const SERVICE_STATUS = Object.freeze({ Active: "Active", Inactive: "Inactive", NonExistent: "NonExistent", Unknown: "Unknown" });

function createServiceModeClient({ service }) {
    return Object.freeze({
        status: SERVICE_STATUS,
        statusService: () => service.status(),
        needUpdate: () => service.needUpdate(),
        installService: (method, options) => service.install(method, options), // 透传useSystemMihomo参数
        uninstallService: () => service.uninstall(),
        updateService: (options) => service.update(options)
    });
}

module.exports = { SERVICE_STATUS, createServiceModeClient };
