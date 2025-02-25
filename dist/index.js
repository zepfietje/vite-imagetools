import { basename, extname, parse, relative } from 'node:path';
import { mkdirSync, statSync, createReadStream } from 'node:fs';
import { writeFile, readFile, opendir, stat, rm } from 'node:fs/promises';
import { builtins, builtinOutputFormats, parseURL, extractEntries, resolveConfigs, generateTransforms, applyTransforms, urlFormat, getMetadata } from 'imagetools-core';
export * from 'imagetools-core';
import { createFilter, dataToEsm } from '@rollup/pluginutils';
import sharp from 'sharp';
import { createHash } from 'node:crypto';

const createBasePath = (base) => {
    return ((base === null || base === void 0 ? void 0 : base.replace(/\/$/, '')) || '') + '/@imagetools/';
};
function generateImageID(config, imageHash) {
    return hash([JSON.stringify(config), imageHash]);
}
function hash(keyParts) {
    let hash = createHash('sha1');
    for (const keyPart of keyParts) {
        hash = hash.update(keyPart);
    }
    return hash.digest('hex');
}

const defaultOptions = {
    include: /^[^?]+\.(avif|gif|heif|jpeg|jpg|png|tiff|webp)(\?.*)?$/,
    exclude: 'public/**/*',
    removeMetadata: true
};
function imagetools(userOptions = {}) {
    var _a, _b, _c, _d, _e;
    const pluginOptions = { ...defaultOptions, ...userOptions };
    const cacheOptions = {
        enabled: (_b = (_a = pluginOptions.cache) === null || _a === void 0 ? void 0 : _a.enabled) !== null && _b !== void 0 ? _b : true,
        dir: (_d = (_c = pluginOptions.cache) === null || _c === void 0 ? void 0 : _c.dir) !== null && _d !== void 0 ? _d : './node_modules/.cache/imagetools',
        retention: (_e = pluginOptions.cache) === null || _e === void 0 ? void 0 : _e.retention
    };
    mkdirSync(`${cacheOptions.dir}`, { recursive: true });
    const filter = createFilter(pluginOptions.include, pluginOptions.exclude);
    const transformFactories = pluginOptions.extendTransforms ? pluginOptions.extendTransforms(builtins) : builtins;
    const outputFormats = pluginOptions.extendOutputFormats
        ? pluginOptions.extendOutputFormats(builtinOutputFormats)
        : builtinOutputFormats;
    let viteConfig;
    let basePath;
    const generatedImages = new Map();
    return {
        name: 'imagetools',
        enforce: 'pre',
        configResolved(cfg) {
            viteConfig = cfg;
            basePath = createBasePath(viteConfig.base);
        },
        async load(id) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
            if (!filter(id))
                return null;
            const srcURL = parseURL(id);
            const pathname = decodeURIComponent(srcURL.pathname);
            // lazy loaders so that we can load the metadata in defaultDirectives if needed
            // but if there are no directives then we can just skip loading
            let lazyImg;
            const lazyLoadImage = () => {
                if (lazyImg)
                    return lazyImg;
                return (lazyImg = sharp(pathname));
            };
            let lazyMetadata;
            const lazyLoadMetadata = async () => {
                if (lazyMetadata)
                    return lazyMetadata;
                return (lazyMetadata = await lazyLoadImage().metadata());
            };
            const defaultDirectives = typeof pluginOptions.defaultDirectives === 'function'
                ? await pluginOptions.defaultDirectives(srcURL, lazyLoadMetadata)
                : pluginOptions.defaultDirectives || new URLSearchParams();
            const directives = new URLSearchParams({
                ...Object.fromEntries(defaultDirectives),
                ...Object.fromEntries(srcURL.searchParams)
            });
            if (!directives.toString())
                return null;
            const img = lazyLoadImage();
            const widthParam = directives.get('w');
            const heightParam = directives.get('h');
            if (directives.get('allowUpscale') !== 'true' && (widthParam || heightParam)) {
                const metadata = await lazyLoadMetadata();
                const clamp = (s, intrinsic) => [...new Set(s.split(';').map((d) => (parseInt(d) <= intrinsic ? d : intrinsic.toString())))].join(';');
                if (widthParam) {
                    const intrinsicWidth = metadata.width || 0;
                    directives.set('w', clamp(widthParam, intrinsicWidth));
                }
                if (heightParam) {
                    const intrinsicHeight = metadata.height || 0;
                    directives.set('h', clamp(heightParam, intrinsicHeight));
                }
            }
            const parameters = extractEntries(directives);
            const imageConfigs = (_b = (_a = pluginOptions.resolveConfigs) === null || _a === void 0 ? void 0 : _a.call(pluginOptions, parameters, outputFormats)) !== null && _b !== void 0 ? _b : resolveConfigs(parameters, outputFormats);
            const outputMetadatas = [];
            const logger = {
                info: (msg) => viteConfig.logger.info(msg),
                warn: (msg) => this.warn(msg),
                error: (msg) => this.error(msg)
            };
            const imageBuffer = await img.clone().toBuffer();
            const imageHash = hash([imageBuffer]);
            for (const config of imageConfigs) {
                const id = generateImageID(config, imageHash);
                let image;
                let metadata;
                if (cacheOptions.enabled && ((_d = (_c = statSync(`${cacheOptions.dir}/${id}`, { throwIfNoEntry: false })) === null || _c === void 0 ? void 0 : _c.size) !== null && _d !== void 0 ? _d : 0) > 0) {
                    metadata = (await sharp(`${cacheOptions.dir}/${id}`).metadata());
                    // we set the format on the metadata during transformation using the format directive
                    // when restoring from the cache, we use sharp to read it from the image and that results in a different value for avif images
                    // see https://github.com/lovell/sharp/issues/2504 and https://github.com/lovell/sharp/issues/3746
                    if (config.format === 'avif' && metadata.format === 'heif' && metadata.compression === 'av1')
                        metadata.format = 'avif';
                }
                else {
                    const { transforms } = generateTransforms(config, transformFactories, srcURL.searchParams, logger);
                    const res = await applyTransforms(transforms, img, pluginOptions.removeMetadata);
                    metadata = res.metadata;
                    if (cacheOptions.enabled) {
                        await writeFile(`${cacheOptions.dir}/${id}`, await res.image.toBuffer());
                    }
                    else {
                        image = res.image;
                    }
                }
                generatedImages.set(id, { image, metadata });
                if (directives.has('inline')) {
                    metadata.src = `data:image/${metadata.format};base64,${(image
                        ? await image.toBuffer()
                        : await readFile(`${cacheOptions.dir}/${id}`)).toString('base64')}`;
                }
                else if (viteConfig.command === 'serve') {
                    metadata.src = ((_f = (_e = viteConfig === null || viteConfig === void 0 ? void 0 : viteConfig.server) === null || _e === void 0 ? void 0 : _e.origin) !== null && _f !== void 0 ? _f : '') + basePath + id;
                }
                else {
                    const parsedPath = parse(pathname);
                    const relativeDir = relative(viteConfig.root, parsedPath.dir);

                    const fileHandle = this.emitFile({
                        name: `${relativeDir}/${parsedPath.name}.${metadata.format}`,
                        source: image ? await image.toBuffer() : await readFile(`${cacheOptions.dir}/${id}`),
                        type: 'asset'
                    });
                    metadata.src = `__VITE_ASSET__${fileHandle}__`;
                }
                metadata.image = image;
                outputMetadatas.push(metadata);
            }
            let outputFormat = urlFormat();
            const asParam = (_g = directives.get('as')) === null || _g === void 0 ? void 0 : _g.split(':');
            const as = asParam ? asParam[0] : undefined;
            for (const [key, format] of Object.entries(outputFormats)) {
                if (as === key) {
                    outputFormat = format(asParam && asParam[1] ? asParam[1].split(';') : undefined);
                    break;
                }
            }
            return dataToEsm(await outputFormat(outputMetadatas), {
                namedExports: (_k = (_h = pluginOptions.namedExports) !== null && _h !== void 0 ? _h : (_j = viteConfig.json) === null || _j === void 0 ? void 0 : _j.namedExports) !== null && _k !== void 0 ? _k : true,
                compact: (_l = !!viteConfig.build.minify) !== null && _l !== void 0 ? _l : false,
                preferConst: true
            });
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                var _a, _b;
                if ((_a = req.url) === null || _a === void 0 ? void 0 : _a.startsWith(basePath)) {
                    const [, id] = req.url.split(basePath);
                    const { image, metadata } = (_b = generatedImages.get(id)) !== null && _b !== void 0 ? _b : {};
                    if (!metadata)
                        throw new Error(`vite-imagetools cannot find image with id "${id}" this is likely an internal error`);
                    if (!image) {
                        res.setHeader('Content-Type', `image/${metadata.format}`);
                        return createReadStream(`${cacheOptions.dir}/${id}`).pipe(res);
                    }
                    if (pluginOptions.removeMetadata === false) {
                        image.withMetadata();
                    }
                    res.setHeader('Content-Type', `image/${getMetadata(image, 'format')}`);
                    return image.clone().pipe(res);
                }
                next();
            });
        },
        async buildEnd(error) {
            if (!error && cacheOptions.enabled && cacheOptions.retention !== undefined && viteConfig.command !== 'serve') {
                const dir = await opendir(cacheOptions.dir);
                for await (const dirent of dir) {
                    if (dirent.isFile()) {
                        if (generatedImages.has(dirent.name))
                            continue;
                        const imagePath = `${cacheOptions.dir}/${dirent.name}`;
                        const stats = await stat(imagePath);
                        if (Date.now() - stats.mtimeMs > cacheOptions.retention * 1000) {
                            console.debug(`deleting stale cached image ${dirent.name}`);
                            await rm(imagePath);
                        }
                    }
                }
            }
        }
    };
}

export { imagetools };
//# sourceMappingURL=index.js.map
