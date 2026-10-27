// Entry for the Anti-Anti-Detect-inator's page probes. Based on CreepJS
// (https://github.com/abrahamjuliot/creepjs, MIT, (c) Abraham Juliot), commit
// 10aa6724cd33a1015db1574211890518cd04f0cc. The collectors, hashing and the
// "creep" (stable) object below are copied from src/creep.ts unchanged. What
// differs: nothing is rendered, nothing is logged, the cloud samples and the
// script-size fetch are not used, WebRTC is left to stop.js (J11), and a compact
// summary is exposed as globalThis.__INATOR_PROBES (a Promise) for stop.js.
// See PATCHES.md for the three small edits made inside src/.

import getOfflineAudioContext, { audioHTML } from './audio'
import getCanvas2d, { canvasHTML } from './canvas'
import getCSS, { cssHTML } from './css'
import getCSSMedia, { cssMediaHTML } from './cssmedia'
import getHTMLElementVersion, { htmlElementVersionHTML } from './document'
import getClientRects, { clientRectsHTML } from './domrect'
import getConsoleErrors, { consoleErrorsHTML } from './engine'
import { timer, getCapturedErrors, caniuse } from './errors'
import getEngineFeatures, { featuresHTML, getFeaturesLie } from './features'
import getFonts, { fontsHTML } from './fonts'
import getHeadlessFeatures, { headlessFeaturesHTML } from './headless'
import getIntl, { intlHTML } from './intl'
import { getLies, PARENT_PHANTOM } from './lies'
import getMaths, { mathsHTML } from './math'
import getMedia, { mediaHTML } from './media'
import getNavigator, { navigatorHTML } from './navigator'
import getResistance, { resistanceHTML } from './resistance'
import getScreen, { screenHTML } from './screen'
import getVoices, { voicesHTML } from './speech'
import { getStatus, statusHTML } from './status'
import getSVG, { svgHTML } from './svg'
import getTimezone, { timezoneHTML } from './timezone'
import { getTrash } from './trash'
import { getBotHash, getFuzzyHash, hashify } from './utils/crypto'
import { IS_WORKER_SCOPE, IS_BLINK, braveBrowser, getBraveMode, getBraveUnprotectedParameters, hashSlice, LowerEntropy, computeWindowsRelease } from './utils/helpers'
import { patch, html } from './utils/html'
import getCanvasWebgl, { webglHTML } from './webgl'
import getWebRTCData, { getWebRTCDevices, webrtcHTML } from './webrtc'
import getWindowFeatures, { windowFeaturesHTML } from './window'
import getBestWorkerScope, { Scope, spawnWorker, workerScopeHTML, WORKER_TYPE } from './worker'


async function runProbes() {
	'use strict';

	const scope = await spawnWorker()

	if (scope == Scope.WORKER) {
		return
	}

	const isBrave = IS_BLINK ? await braveBrowser() : false
	const braveMode = isBrave ? getBraveMode() : {}
	const braveFingerprintingBlocking = isBrave && (braveMode.standard || braveMode.strict)

	const fingerprint = async () => {
		const timeStart = timer()
		const fingerprintTimeStart = timer()
		// @ts-ignore
		const [
			workerScopeComputed,
			voicesComputed,
			offlineAudioContextComputed,
			canvasWebglComputed,
			canvas2dComputed,
			windowFeaturesComputed,
			htmlElementVersionComputed,
			cssComputed,
			cssMediaComputed,
			screenComputed,
			mathsComputed,
			consoleErrorsComputed,
			timezoneComputed,
			clientRectsComputed,
			fontsComputed,
			mediaComputed,
			svgComputed,
			resistanceComputed,
			intlComputed,
		] = await Promise.all([
			getBestWorkerScope(),
			getVoices(),
			getOfflineAudioContext(),
			getCanvasWebgl(),
			getCanvas2d(),
			getWindowFeatures(),
			getHTMLElementVersion(),
			getCSS(),
			getCSSMedia(),
			getScreen(),
			getMaths(),
			getConsoleErrors(),
			getTimezone(),
			getClientRects(),
			getFonts(),
			getMedia(),
			getSVG(),
			getResistance(),
			getIntl(),
		]).catch((error) => console.error(error.message))

		const navigatorComputed = await getNavigator(workerScopeComputed)
			.catch((error) => console.error(error.message))

		// @ts-ignore
		const [
			headlessComputed,
			featuresComputed,
		] = await Promise.all([
			getHeadlessFeatures({
				webgl: canvasWebglComputed,
				workerScope: workerScopeComputed,
			}),
			getEngineFeatures({
				cssComputed,
				navigatorComputed,
				windowFeaturesComputed,
			}),
		]).catch((error) => console.error(error.message))

		// @ts-ignore
		const [
			liesComputed,
			trashComputed,
			capturedErrorsComputed,
		] = await Promise.all([
			getLies(),
			getTrash(),
			getCapturedErrors(),
		]).catch((error) => console.error(error.message))

		const fingerprintTimeEnd = fingerprintTimeStart()

		// GPU Prediction
		const { parameters: gpuParameter } = canvasWebglComputed || {}
		const reducedGPUParameters = {
			...(
				braveFingerprintingBlocking ? getBraveUnprotectedParameters(gpuParameter) :
					gpuParameter
			),
			RENDERER: undefined,
			SHADING_LANGUAGE_VERSION: undefined,
			UNMASKED_RENDERER_WEBGL: undefined,
			UNMASKED_VENDOR_WEBGL: undefined,
			VERSION: undefined,
			VENDOR: undefined,
		}

		// Hashing
		const hashStartTime = timer()
		// @ts-ignore
		const [
			windowHash,
			headlessHash,
			htmlHash,
			cssMediaHash,
			cssHash,
			styleHash,
			styleSystemHash,
			screenHash,
			voicesHash,
			canvas2dHash,
			canvas2dImageHash,
			canvas2dPaintHash,
			canvas2dTextHash,
			canvas2dEmojiHash,
			canvasWebglHash,
			canvasWebglImageHash,
			canvasWebglParametersHash,
			pixelsHash,
			pixels2Hash,
			mathsHash,
			consoleErrorsHash,
			timezoneHash,
			rectsHash,
			domRectHash,
			audioHash,
			fontsHash,
			workerHash,
			mediaHash,
			mimeTypesHash,
			navigatorHash,
			liesHash,
			trashHash,
			errorsHash,
			svgHash,
			resistanceHash,
			intlHash,
			featuresHash,
			deviceOfTimezoneHash,
		] = await Promise.all([
			hashify(windowFeaturesComputed),
			hashify(headlessComputed),
			hashify((htmlElementVersionComputed || {}).keys),
			hashify(cssMediaComputed),
			hashify(cssComputed),
			hashify((cssComputed || {}).computedStyle),
			hashify((cssComputed || {}).system),
			hashify(screenComputed),
			hashify(voicesComputed),
			hashify(canvas2dComputed),
			hashify((canvas2dComputed || {}).dataURI),
			hashify((canvas2dComputed || {}).paintURI),
			hashify((canvas2dComputed || {}).textURI),
			hashify((canvas2dComputed || {}).emojiURI),
			hashify(canvasWebglComputed),
			hashify((canvasWebglComputed || {}).dataURI),
			hashify(reducedGPUParameters),
			((canvasWebglComputed || {}).pixels || []).length ? hashify(canvasWebglComputed.pixels) : undefined,
			((canvasWebglComputed || {}).pixels2 || []).length ? hashify(canvasWebglComputed.pixels2) : undefined,
			hashify((mathsComputed || {}).data),
			hashify((consoleErrorsComputed || {}).errors),
			hashify(timezoneComputed),
			hashify(clientRectsComputed),
			hashify([
				(clientRectsComputed || {}).elementBoundingClientRect,
				(clientRectsComputed || {}).elementClientRects,
				(clientRectsComputed || {}).rangeBoundingClientRect,
				(clientRectsComputed || {}).rangeClientRects,
			]),
			hashify(offlineAudioContextComputed),
			hashify(fontsComputed),
			hashify(workerScopeComputed),
			hashify(mediaComputed),
			hashify((mediaComputed || {}).mimeTypes),
			hashify(navigatorComputed),
			hashify(liesComputed),
			hashify(trashComputed),
			hashify(capturedErrorsComputed),
			hashify(svgComputed),
			hashify(resistanceComputed),
			hashify(intlComputed),
			hashify(featuresComputed),
			hashify((() => {
				const {
					bluetoothAvailability,
					device,
					deviceMemory,
					hardwareConcurrency,
					maxTouchPoints,
					oscpu,
					platform,
					system,
					userAgentData,
				} = navigatorComputed || {}
				const {
					architecture,
					bitness,
					mobile,
					model,
					platform: uaPlatform,
					platformVersion,
				} = userAgentData || {}
				const { 'any-pointer': anyPointer } = cssMediaComputed?.mediaCSS || {}
				const { colorDepth, pixelDepth, height, width } = screenComputed || {}
				const { location, locationEpoch, zone } = timezoneComputed || {}
				const {
					deviceMemory: deviceMemoryWorker,
					hardwareConcurrency: hardwareConcurrencyWorker,
					gpu,
					platform: platformWorker,
					system: systemWorker,
					timezoneLocation: locationWorker,
					userAgentData: userAgentDataWorker,
				} = workerScopeComputed || {}
				const { compressedGPU, confidence } = gpu || {}
				const {
					architecture: architectureWorker,
					bitness: bitnessWorker,
					mobile: mobileWorker,
					model: modelWorker,
					platform: uaPlatformWorker,
					platformVersion: platformVersionWorker,
				} = userAgentDataWorker || {}

				return [
					anyPointer,
					architecture,
					architectureWorker,
					bitness,
					bitnessWorker,
					bluetoothAvailability,
					colorDepth,
					...(compressedGPU && confidence != 'low' ? [compressedGPU] : []),
					device,
					deviceMemory,
					deviceMemoryWorker,
					hardwareConcurrency,
					hardwareConcurrencyWorker,
					height,
					location,
					locationWorker,
					locationEpoch,
					maxTouchPoints,
					mobile,
					mobileWorker,
					model,
					modelWorker,
					oscpu,
					pixelDepth,
					platform,
					platformWorker,
					platformVersion,
					platformVersionWorker,
					system,
					systemWorker,
					uaPlatform,
					uaPlatformWorker,
					width,
					zone,
				]
			})()),
		]).catch((error) => console.error(error.message))

		// console.log(performance.now()-start)
		const hashTimeEnd = hashStartTime()
		const timeEnd = timeStart()


		if (PARENT_PHANTOM) {
			// @ts-ignore
			PARENT_PHANTOM.parentNode.removeChild(PARENT_PHANTOM)
		}

		const fingerprint = {
			workerScope: !workerScopeComputed ? undefined : { ...workerScopeComputed, $hash: workerHash},
			navigator: !navigatorComputed ? undefined : {...navigatorComputed, $hash: navigatorHash},
			windowFeatures: !windowFeaturesComputed ? undefined : {...windowFeaturesComputed, $hash: windowHash},
			headless: !headlessComputed ? undefined : {...headlessComputed, $hash: headlessHash},
			htmlElementVersion: !htmlElementVersionComputed ? undefined : {...htmlElementVersionComputed, $hash: htmlHash},
			cssMedia: !cssMediaComputed ? undefined : {...cssMediaComputed, $hash: cssMediaHash},
			css: !cssComputed ? undefined : {...cssComputed, $hash: cssHash},
			screen: !screenComputed ? undefined : {...screenComputed, $hash: screenHash},
			voices: !voicesComputed ? undefined : {...voicesComputed, $hash: voicesHash},
			media: !mediaComputed ? undefined : {...mediaComputed, $hash: mediaHash},
			canvas2d: !canvas2dComputed ? undefined : {...canvas2dComputed, $hash: canvas2dHash},
			canvasWebgl: !canvasWebglComputed ? undefined : {...canvasWebglComputed, pixels: pixelsHash, pixels2: pixels2Hash, $hash: canvasWebglHash},
			maths: !mathsComputed ? undefined : {...mathsComputed, $hash: mathsHash},
			consoleErrors: !consoleErrorsComputed ? undefined : {...consoleErrorsComputed, $hash: consoleErrorsHash},
			timezone: !timezoneComputed ? undefined : {...timezoneComputed, $hash: timezoneHash},
			clientRects: !clientRectsComputed ? undefined : {...clientRectsComputed, $hash: rectsHash},
			offlineAudioContext: !offlineAudioContextComputed ? undefined : {...offlineAudioContextComputed, $hash: audioHash},
			fonts: !fontsComputed ? undefined : {...fontsComputed, $hash: fontsHash},
			lies: !liesComputed ? undefined : {...liesComputed, $hash: liesHash},
			trash: !trashComputed ? undefined : {...trashComputed, $hash: trashHash},
			capturedErrors: !capturedErrorsComputed ? undefined : {...capturedErrorsComputed, $hash: errorsHash},
			svg: !svgComputed ? undefined : {...svgComputed, $hash: svgHash },
			resistance: !resistanceComputed ? undefined : {...resistanceComputed, $hash: resistanceHash},
			intl: !intlComputed ? undefined : {...intlComputed, $hash: intlHash},
			features: !featuresComputed ? undefined : {...featuresComputed, $hash: featuresHash},
		}
		return {
			fingerprint,
			styleSystemHash,
			styleHash,
			domRectHash,
			mimeTypesHash,
			canvas2dImageHash,
			canvasWebglImageHash,
			canvas2dPaintHash,
			canvas2dTextHash,
			canvas2dEmojiHash,
			canvasWebglParametersHash,
			deviceOfTimezoneHash,
			timeEnd,
		}
	}

	// fingerprint and render
	const [
		{
			fingerprint: fp,
			styleSystemHash,
			styleHash,
			domRectHash,
			mimeTypesHash,
			canvas2dImageHash,
			canvas2dPaintHash,
			canvas2dTextHash,
			canvas2dEmojiHash,
			canvasWebglImageHash,
			canvasWebglParametersHash,
			deviceOfTimezoneHash,
			timeEnd,
		},
	] = await Promise.all([
		fingerprint().catch((error) => console.error(error)) || {},
	])

	if (!fp) {
		throw new Error('Fingerprint failed!')
	}


	const hardenEntropy = (workerScope, prop) => {
		return (
			!workerScope ? prop :
				(workerScope.localeEntropyIsTrusty && workerScope.localeIntlEntropyIsTrusty) ? prop :
					undefined
		)
	}

	const privacyResistFingerprinting = (
		fp.resistance && /^(tor browser|firefox)$/i.test(fp.resistance.privacy)
	)

	// harden gpu
	const hardenGPU = (canvasWebgl) => {
		const { gpu: { confidence, compressedGPU } } = canvasWebgl
		return (
			confidence == 'low' ? {} : {
				UNMASKED_RENDERER_WEBGL: compressedGPU,
				UNMASKED_VENDOR_WEBGL: canvasWebgl.parameters.UNMASKED_VENDOR_WEBGL,
			}
		)
	}

	const creep = {
		navigator: (
			!fp.navigator || fp.navigator.lied ? undefined : {
				bluetoothAvailability: fp.navigator.bluetoothAvailability,
				device: fp.navigator.device,
				deviceMemory: fp.navigator.deviceMemory,
				hardwareConcurrency: fp.navigator.hardwareConcurrency,
				maxTouchPoints: fp.navigator.maxTouchPoints,
				oscpu: fp.navigator.oscpu,
				platform: fp.navigator.platform,
				system: fp.navigator.system,
				userAgentData: {
					...(fp.navigator.userAgentData || {}),
					// loose
					brandsVersion: undefined,
					uaFullVersion: undefined,
				},
				vendor: fp.navigator.vendor,
			}
		),
		screen: (
			!fp.screen || fp.screen.lied || privacyResistFingerprinting || LowerEntropy.SCREEN ? undefined :
				hardenEntropy(
					fp.workerScope, {
						height: fp.screen.height,
						width: fp.screen.width,
						pixelDepth: fp.screen.pixelDepth,
						colorDepth: fp.screen.colorDepth,
						lied: fp.screen.lied,
					},
				)
		),
		workerScope: !fp.workerScope || fp.workerScope.lied ? undefined : {
			deviceMemory: (
				braveFingerprintingBlocking ? undefined : fp.workerScope.deviceMemory
			),
			hardwareConcurrency: (
				braveFingerprintingBlocking ? undefined : fp.workerScope.hardwareConcurrency
			),
			// system locale in blink
			language: !LowerEntropy.TIME_ZONE ? fp.workerScope.language : undefined,
			platform: fp.workerScope.platform,
			system: fp.workerScope.system,
			device: fp.workerScope.device,
			timezoneLocation: (
				!LowerEntropy.TIME_ZONE ?
					hardenEntropy(fp.workerScope, fp.workerScope.timezoneLocation) :
						undefined
			),
			webglRenderer: (
				(fp.workerScope.gpu.confidence != 'low') ? fp.workerScope.gpu.compressedGPU : undefined
			),
			webglVendor: (
				(fp.workerScope.gpu.confidence != 'low') ? fp.workerScope.webglVendor : undefined
			),
			userAgentData: {
				...fp.workerScope.userAgentData,
				// loose
				brandsVersion: undefined,
				uaFullVersion: undefined,
			},
		},
		media: fp.media,
		canvas2d: ((canvas2d) => {
			if (!canvas2d) {
				return
			}
			const { lied, liedTextMetrics } = canvas2d
			let data
			if (!lied) {
				const { dataURI, paintURI, textURI, emojiURI } = canvas2d
				data = {
					lied,
					...{ dataURI, paintURI, textURI, emojiURI },
				}
			}
			if (!liedTextMetrics) {
				const { textMetricsSystemSum, emojiSet } = canvas2d
				data = {
					...(data || {}),
					...{ textMetricsSystemSum, emojiSet },
				}
			}
			return data
		})(fp.canvas2d),
		canvasWebgl: (!fp.canvasWebgl || fp.canvasWebgl.lied || LowerEntropy.WEBGL) ? undefined : (
			braveFingerprintingBlocking ? {
				parameters: {
					...getBraveUnprotectedParameters(fp.canvasWebgl.parameters),
					...hardenGPU(fp.canvasWebgl),
				},
			} : {
				...((gl, canvas2d) => {
					if ((canvas2d && canvas2d.lied) || LowerEntropy.CANVAS) {
						// distrust images
						const { extensions, gpu, lied, parameterOrExtensionLie } = gl
						return {
							extensions,
							gpu,
							lied,
							parameterOrExtensionLie,
						}
					}
					return gl
				})(fp.canvasWebgl, fp.canvas2d),
				parameters: {
					...fp.canvasWebgl.parameters,
					...hardenGPU(fp.canvasWebgl),
				},
			}
		),
		cssMedia: !fp.cssMedia ? undefined : {
			reducedMotion: caniuse(() => fp.cssMedia.mediaCSS['prefers-reduced-motion']),
			colorScheme: (
				braveFingerprintingBlocking ? undefined :
				caniuse(() => fp.cssMedia.mediaCSS['prefers-color-scheme'])
			),
			monochrome: caniuse(() => fp.cssMedia.mediaCSS.monochrome),
			invertedColors: caniuse(() => fp.cssMedia.mediaCSS['inverted-colors']),
			forcedColors: caniuse(() => fp.cssMedia.mediaCSS['forced-colors']),
			anyHover: caniuse(() => fp.cssMedia.mediaCSS['any-hover']),
			hover: caniuse(() => fp.cssMedia.mediaCSS.hover),
			anyPointer: caniuse(() => fp.cssMedia.mediaCSS['any-pointer']),
			pointer: caniuse(() => fp.cssMedia.mediaCSS.pointer),
			colorGamut: caniuse(() => fp.cssMedia.mediaCSS['color-gamut']),
			screenQuery: (
				privacyResistFingerprinting || (LowerEntropy.SCREEN || LowerEntropy.IFRAME_SCREEN) ?
					undefined :
						hardenEntropy(fp.workerScope, caniuse(() => fp.cssMedia.screenQuery))
			),
		},
		css: !fp.css ? undefined : fp.css.system.fonts,
		timezone: !fp.timezone || fp.timezone.lied || LowerEntropy.TIME_ZONE ? undefined : {
			locationMeasured: hardenEntropy(fp.workerScope, fp.timezone.locationMeasured),
			lied: fp.timezone.lied,
		},
		offlineAudioContext: !fp.offlineAudioContext ? undefined : (
			fp.offlineAudioContext.lied || LowerEntropy.AUDIO ? undefined :
				fp.offlineAudioContext
		),
		fonts: !fp.fonts || fp.fonts.lied || LowerEntropy.FONTS ? undefined : fp.fonts.fontFaceLoadFonts,
		forceRenew: 1737085481442,
	}


	// ---- Anti-Anti-Detect-inator summary (not part of CreepJS) -------------
	const [fpHash, creepHash, fuzzyHash, status, mediaDevices] = await Promise.all([
		hashify(fp), hashify(creep), getFuzzyHash(fp).catch(() => undefined),
		getStatus().catch(() => undefined), getWebRTCDevices().catch(() => undefined),
	])
	const bot = (() => { try { return getBotHash(fp, { getFeaturesLie, computeWindowsRelease }) } catch (e) { return undefined } })()
	const trueKeys = (o) => Object.keys(o || {}).filter((k) => o[k] === true)
	const cap = (a, n) => (a || []).slice(0, n)
	const clip = (x, n = 160) => (typeof x == 'string' && x.length > n ? x.slice(0, n) : x)
	const comps = Object.keys(fp)
	const hashes = {}
	comps.forEach((k) => { if (fp[k] && fp[k].$hash) hashes[k] = fp[k].$hash })
	Object.assign(hashes, {
		styleSystem: styleSystemHash, style: styleHash, domRect: domRectHash, mimeTypes: mimeTypesHash,
		canvas2dImage: canvas2dImageHash, canvas2dPaint: canvas2dPaintHash, canvas2dText: canvas2dTextHash,
		canvas2dEmoji: canvas2dEmojiHash, canvasWebglImage: canvasWebglImageHash,
		canvasWebglParameters: canvasWebglParametersHash, deviceOfTimezone: deviceOfTimezoneHash,
	})
	const lieData = (fp.lies && fp.lies.data) || {}
	const ws = fp.workerScope || {}
	const nav = fp.navigator || {}
	const gl = fp.canvasWebgl || {}
	const hl = fp.headless || {}
	const ft = fp.features || {}
	const tz = fp.timezone || {}
	return {
		source: 'creepjs@10aa672',
		ms: Math.round(timeEnd || 0),
		fpId: creepHash,
		looseId: fpHash,
		fuzzy: fuzzyHash,
		bot,
		lied: comps.filter((k) => fp[k] && (fp[k].lied === true || fp[k].liedTextMetrics === true)),
		lies: { total: (fp.lies || {}).totalLies || 0, apis: cap(Object.keys(lieData).sort(), 40),
			sample: cap(Object.keys(lieData).sort().flatMap((k) => lieData[k].map((x) => `${k}: ${x}`)), 12).map((x) => clip(x)) },
		headless: fp.headless ? {
			headless: hl.headlessRating, likeHeadless: hl.likeHeadlessRating, stealth: hl.stealthRating,
			headlessKeys: trueKeys(hl.headless), likeHeadlessKeys: trueKeys(hl.likeHeadless), stealthKeys: trueKeys(hl.stealth),
			platformEstimate: hl.platformEstimate && hl.platformEstimate[1],
		} : undefined,
		resistance: fp.resistance ? { privacy: fp.resistance.privacy, mode: fp.resistance.mode,
			extension: fp.resistance.extension, engine: fp.resistance.engine } : undefined,
		worker: fp.workerScope ? {
			type: WORKER_TYPE, lied: !!ws.lied, lies: ws.lies && { os: ws.lies.os, engine: ws.lies.engine, version: ws.lies.version, platformVersion: ws.lies.platformVersion,
				proto: ws.lies.proto ? Object.keys(ws.lies.proto).length : 0 },
			userAgent: clip(ws.userAgent, 300), platform: ws.platform, system: ws.system, device: ws.device,
			hardwareConcurrency: ws.hardwareConcurrency, deviceMemory: ws.deviceMemory, language: ws.language,
			timezoneLocation: ws.timezoneLocation, gpu: ws.gpu && { renderer: ws.gpu.compressedGPU, confidence: ws.gpu.confidence },
			userAgentVersion: ws.userAgentVersion,
		} : undefined,
		navigator: fp.navigator ? { lied: !!nav.lied, platform: nav.platform, system: nav.system, device: nav.device,
			hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory, maxTouchPoints: nav.maxTouchPoints,
			uaData: nav.userAgentData && { platform: nav.userAgentData.platform, platformVersion: nav.userAgentData.platformVersion,
				architecture: nav.userAgentData.architecture, bitness: nav.userAgentData.bitness, model: nav.userAgentData.model,
				mobile: nav.userAgentData.mobile } } : undefined,
		features: fp.features ? { version: ft.version, versionRange: ft.versionRange, cssVersion: ft.cssVersion,
			jsVersion: ft.jsVersion, windowVersion: ft.windowVersion, featuresLie: (() => { try { return !!getFeaturesLie(fp) } catch (e) { return undefined } })() } : undefined,
		gpu: fp.canvasWebgl ? { renderer: gl.gpu && gl.gpu.compressedGPU, confidence: gl.gpu && gl.gpu.confidence,
			grade: gl.gpu && gl.gpu.grade, parameterOrExtensionLie: !!gl.parameterOrExtensionLie } : undefined,
		timezone: fp.timezone ? { zone: tz.zone, location: tz.location, locationMeasured: tz.locationMeasured,
			locationEpoch: tz.locationEpoch, lied: !!tz.lied } : undefined,
		fonts: fp.fonts ? { platformVersion: fp.fonts.platformVersion, apps: cap(fp.fonts.apps, 20),
			count: (fp.fonts.fontFaceLoadFonts || []).length } : undefined,
		voices: fp.voices ? { count: ((fp.voices.local || []).length || 0) + ((fp.voices.remote || []).length || 0) } : undefined,
		trash: { count: ((fp.trash || {}).trashBin || []).length, sample: cap((fp.trash || {}).trashBin, 6).map((t) => clip(typeof t == 'string' ? t : JSON.stringify(t))) },
		errors: { count: ((fp.capturedErrors || {}).data || []).length },
		status: status ? { memoryGB: status.memoryInGigabytes, quotaGB: status.quotaInGigabytes, quotaIsInsecure: status.quotaIsInsecure,
			effectiveType: status.effectiveType, rtt: status.rtt, downlink: status.downlink, saveData: status.saveData,
			stackSize: status.stackSize, timingRes: status.timingRes, charging: status.charging, level: status.level } : undefined,
		mediaDevices,
		hashes,
	}
}

const PROBES = runProbes().catch((e) => ({ error: String((e && e.message) || e) }))
// @ts-ignore
if (!IS_WORKER_SCOPE) globalThis.__INATOR_PROBES = PROBES
