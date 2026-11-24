"use strict";

const { targets, prepareMihomo, updateMihomo } = require("./mihomo-dependency");

async function main(args = process.argv.slice(2)) {
    const [command, ...options] = args;
    // console.log("options:", options)
    if (command === "update") {
        const version = options[0] && options[0].replace(/^v/, "");
        const targetNames = [];
        const localArchives = new Map();
        const localBinaries = new Map();
        for (let index = 1; index < options.length; index++) {
            const arg = options[index];
            if (arg === "--target" && options[index + 1]) targetNames.push(options[++index]);
            else if (arg === "--archive" && options[index + 1]) {
                const separator = options[++index].indexOf("=");
                if (separator < 1) throw new Error("Expected --archive <target>=<path>");
                localArchives.set(options[index].slice(0, separator), options[index].slice(separator + 1));
            }
            else if (arg === "--binary" && options[index + 1]) {
                const separator = options[++index].indexOf("=");
                if (separator < 1) throw new Error("Expected --binary <target>=<path>");
                localBinaries.set(options[index].slice(0, separator), options[index].slice(separator + 1));
            }
            else if (targets[arg]) targetNames.push(arg);                       // npm 吞掉 --target 后的裸值
            else if (targets[arg.slice(0, arg.indexOf("="))]) {                 // npm 吞掉 --binary/--archive 后的 name=path
                localBinaries.set(arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1));
            }
            else throw new Error(`Unknown Mihomo update option: ${arg}`);
        }
        if (!version) throw new Error("Usage: mihomo.js prepare [--all | --target <target>] [--offline], or mihomo.js update <exact-version> [--target <target>]... [--archive <target>=<path>]...");
        const manifest = await updateMihomo(version, {
            targetNames: targetNames.length ? targetNames : undefined,
            localArchives,
            localBinaries,
        });
        console.log(`Locked Mihomo targets: ${manifest.targets.map(entry => `${entry.target}@${entry.version}`).join(", ")}. Review the manifest, notices and service allow-lists before committing.`);
        return;
    }
    if (command === "prepare") {
        const targetNames = [];
        let all = false;
        let offline = process.env.CFW_MIHOMO_OFFLINE === "1";
        for (let index = 0; index < options.length; index++) {
            if (options[index] === "--all") all = true;
            else if (options[index] === "--offline") offline = true;
            else if (options[index] === "--target" && options[index + 1]) targetNames.push(options[++index]);
            else throw new Error(`Unknown Mihomo preparation option: ${options[index]}`);
        }
        if (all && targetNames.length) throw new Error("Use --all or --target, not both");
        if (!all && !targetNames.length) {
            const host = Object.keys(targets).find(name => targets[name].platform === process.platform && targets[name].arch === process.arch);
            if (!host) throw new Error(`Unsupported Mihomo host: ${process.platform}/${process.arch}; specify --target`);
            targetNames.push(host);
        }
        const manifest = await prepareMihomo({ targetNames: all ? Object.keys(targets) : targetNames, offline });
        console.log(`Mihomo dependencies verified and ready`);
        return;
    }
    throw new Error("Usage: mihomo.js prepare [--all | --target <target>] [--offline], or mihomo.js update <exact-version>");
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
