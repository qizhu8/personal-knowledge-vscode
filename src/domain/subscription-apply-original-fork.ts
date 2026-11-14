// @ts-nocheck
// Repeatable original executable capture; synthetic fixture use only.
import * as fs from "fs";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
const FILE_FORK_TYPES = ["skills", "notes", "papers", "prompts", "scripts"];
export function forkRootName(brokerName, publisherUser, publisherHost) {
    const clean = (value, fallback, limit) => value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").slice(0, limit) || fallback;
    const cleanBroker = clean(brokerName.replace(/^_folk_+/i, ""), "Broker", 48);
    const user = clean(publisherUser, "unknown-user", 32);
    const host = clean(publisherHost, "unknown-host", 48);
    const identity = [cleanBroker, user, host].map(value => value.toLocaleLowerCase()).join("\u0000");
    const identityHash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
    return `_folk_${cleanBroker} - ${user} - ${host}--${identityHash}`;
}
export function forkSubscriptionContent(storeRoot, source) {
    if (source.type === "packages" && source.package)
        return forkPackage(storeRoot, source);
    if (!FILE_FORK_TYPES.includes(source.type))
        throw new Error(`Fork is not supported for ${source.type}.`);
    if (source.folder)
        return forkFolder(storeRoot, source);
    const typeRoot = path.resolve(storeRoot, source.type);
    const folkRoot = safeTarget(typeRoot, forkRootName(source.brokerName, source.publisherUser, source.publisherHost));
    const target = safeTarget(folkRoot, source.remotePath);
    if (fs.existsSync(target))
        throw new Error(`Local fork already exists: ${relativeDisplay(storeRoot, target)}`);
    const assets = checkedAssets(folkRoot, source.assets || []);
    ensureFolkRoot(folkRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, source.content || "", "utf8");
    fs.renameSync(temporary, target);
    writeAssets(assets);
    return relativeDisplay(storeRoot, target);
}
function forkFolder(storeRoot, source) {
    const folder = source.folder;
    const typeRoot = path.resolve(storeRoot, source.type);
    const folkRoot = safeTarget(typeRoot, forkRootName(source.brokerName, source.publisherUser, source.publisherHost));
    if (!folder.path)
        return forkCollection(storeRoot, folkRoot, folder.files);
    const target = safeTarget(folkRoot, folder.path);
    if (fs.existsSync(target))
        throw new Error(`Local fork already exists: ${relativeDisplay(storeRoot, target)}`);
    const checked = folder.files.map(file => ({ ...file, target: safeTarget(target, file.path) }));
    const assets = checkedAssets(folkRoot, source.assets || []);
    const staging = safeTarget(folkRoot, `.${path.basename(folder.path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
        ensureFolkRoot(folkRoot);
        for (const file of checked) {
            const staged = path.join(staging, path.relative(target, file.target));
            fs.mkdirSync(path.dirname(staged), { recursive: true });
            fs.writeFileSync(staged, file.content, "utf8");
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(staging, target);
        writeAssets(assets);
    }
    catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw error;
    }
    return relativeDisplay(storeRoot, target);
}
function forkCollection(storeRoot, folkRoot, files) {
    const checked = files.map(file => ({ ...file, target: safeTarget(folkRoot, file.path) }));
    const conflict = checked.find(file => fs.existsSync(file.target));
    if (conflict)
        throw new Error(`Local fork already exists: ${relativeDisplay(storeRoot, conflict.target)}`);
    ensureFolkRoot(folkRoot);
    for (const file of checked) {
        fs.mkdirSync(path.dirname(file.target), { recursive: true });
        const temporary = `${file.target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        try {
            fs.writeFileSync(temporary, file.content, "utf8");
            fs.renameSync(temporary, file.target);
        }
        catch (error) {
            fs.rmSync(temporary, { force: true });
            throw error;
        }
    }
    return relativeDisplay(storeRoot, folkRoot);
}
function forkPackage(storeRoot, source) {
    const pkg = source.package;
    const packagesRoot = path.resolve(storeRoot, "packages");
    const cleanName = (value, fallback) => value.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
    const originalName = cleanName(pkg.name, "package");
    const brokerName = cleanName(source.brokerName, "Broker");
    const baseName = `${originalName}_${brokerName}`;
    let targetName = baseName;
    let suffix = 0;
    while (fs.existsSync(path.join(packagesRoot, targetName)))
        targetName = `${baseName}${++suffix}`;
    const target = safeTarget(packagesRoot, targetName);
    const checked = pkg.files.map(file => ({ ...file, target: safeTarget(target, file.path) }));
    const staging = safeTarget(packagesRoot, `.${targetName}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
        for (const file of checked) {
            const staged = path.join(staging, path.relative(target, file.target));
            fs.mkdirSync(path.dirname(staged), { recursive: true });
            fs.writeFileSync(staged, file.content, "utf8");
        }
        fs.mkdirSync(staging, { recursive: true });
        fs.writeFileSync(path.join(staging, ".pkm-package.json"), JSON.stringify({
            schema: 1,
            kind: "subscription-fork",
            originalName: pkg.name,
            brokerName: source.brokerName,
            publisherUser: source.publisherUser,
            publisherHost: source.publisherHost,
        }, null, 2) + "\n", "utf8");
        fs.mkdirSync(packagesRoot, { recursive: true });
        fs.renameSync(staging, target);
    }
    catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw error;
    }
    return relativeDisplay(storeRoot, target);
}
function ensureFolkRoot(root) {
    fs.mkdirSync(root, { recursive: true });
    const keep = path.join(root, ".gitkeep");
    if (!fs.existsSync(keep))
        fs.writeFileSync(keep, "", "utf8");
}
function checkedAssets(root, assets) {
    return assets.map(asset => {
        const target = safeTarget(root, asset.path);
        if (fs.existsSync(target) && !fs.readFileSync(target).equals(asset.content)) {
            throw new Error(`Fork asset conflicts with an existing file: ${target}`);
        }
        return { target, content: asset.content };
    });
}
function writeAssets(assets) {
    for (const asset of assets) {
        if (fs.existsSync(asset.target)) {
            if (!fs.readFileSync(asset.target).equals(asset.content))
                throw new Error(`Fork asset conflicts with an existing file: ${asset.target}`);
            continue;
        }
        fs.mkdirSync(path.dirname(asset.target), { recursive: true });
        const temporary = `${asset.target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        fs.writeFileSync(temporary, asset.content);
        fs.renameSync(temporary, asset.target);
    }
}
function safeTarget(root, ...relativeParts) {
    const segments = relativeParts.flatMap(part => part.replace(/\\/g, "/").split("/"));
    if (segments.some(segment => !segment || segment === "." || segment === ".."))
        throw new Error("Fork source contains an unsafe path.");
    const target = path.resolve(root, ...segments);
    if (!target.startsWith(path.resolve(root) + path.sep))
        throw new Error("Fork target escapes the Knowledge Root.");
    return target;
}
function relativeDisplay(storeRoot, target) {
    return path.relative(storeRoot, target).replace(/\\/g, "/");
}
