const VID = 0x3367;
const PID = 0x1980;
const SHORT_LEN = 64;
const PROFILE_LEN = 1041;

const MARK_READ = 0xa1;
const MARK_WRITE = 0xa0;
const CMD_IDENT = 0x02;
const CMD_GET = 0x12;
const CMD_SET = 0x11;

const CPI_OFFSETS = [52, 57, 62, 67];
const LOD_VALUES = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7];
const GLASS_LOD_VALUES = [1.0, 2.0];
const GLASS_LOD_FROM_CODE = new Map([
	[0x01, 1.0],
	[0x02, 2.0],
]);
const CODE_FROM_GLASS_LOD = new Map([
	[1.0, 0x01],
	[2.0, 0x02],
]);
const POLL_FROM_CODE = new Map([
	[0x08, 1000],
	[0x04, 2000],
	[0x02, 4000],
	[0x01, 8000],
]);
const CODE_FROM_POLL = new Map([
	[1000, 0x08],
	[2000, 0x04],
	[4000, 0x02],
	[8000, 0x01],
]);

const OFFSETS = {
	cpiCount: 30,
	slamclick: 22,
	liftLed: 24,
	polling: 21,
	lod: 25,
	angleSnap: 26,
	ripple: 27,
	motionSync: 28,
	leftHandedA: 72,
	leftFilter: 77,
	leftHandedB: 79,
	rightFilter: 84,
	middleFilter: 91,
	forwardFilter: 98,
	backFilter: 105,
	glassMode: 127,
	forceMaxSensorFps: 129,
	acceptMulticlick: 130,
};

const defaultProfile = {
	cpiCount: 4,
	cpi: [[800, 800], [1600, 1600], [3200, 3200], [6400, 6400]],
	pollingHz: 8000,
	lod: 1.0,
	motionSync: false,
	angleSnap: false,
	ripple: false,
	liftLed: false,
	glassMode: false,
	forceMaxSensorFps: true,
	slamclick: true,
	filters: {
		left: 8,
		right: 8,
		middle: 8,
		forward: 8,
		back: 8,
	},
};

let device = null;
let rawProfile = null;
let transport = null;
let profile = structuredClone(defaultProfile);
let dirty = false;
let lodTouched = false;
let lastFilterValues = {
	left: 8,
	right: 8,
};
let cpiXySplit = false;

const $ = (id) => document.getElementById(id);
const els = {
	connect: $("btn-connect"),
	configPanel: $("config-panel"),
	actionbar: $("actionbar"),
	statusDot: $("status-dot"),
	statusText: $("status-text"),
	fw: $("fw-version"),
	cpiList: $("cpi-list"),
	cpiCount: $("cpi-count-val"),
	dirty: $("dirty-label"),
	apply: $("btn-apply"),
	read: $("btn-read"),
	reset: $("btn-reset"),
	webhidWarning: $("webhid-warning"),
};

const strategies = [
	{
		name: "WebHID report 0, full buffer",
		commandReport: 0x00,
		writeReport: 0x00,
		includeMarker: true,
		receiveReport: 0x00,
	},
	{
		name: "WebHID report IDs, command body",
		commandReport: MARK_READ,
		writeReport: MARK_WRITE,
		includeMarker: false,
		receiveReport: MARK_READ,
	},
	{
		name: "WebHID report IDs, full buffer",
		commandReport: MARK_READ,
		writeReport: MARK_WRITE,
		includeMarker: true,
		receiveReport: MARK_READ,
	},
];

function blank(len) {
	return new Uint8Array(len);
}

function withMarker(bytes, marker) {
	if (bytes[0] === marker) return bytes;
	const out = new Uint8Array(bytes.length + 1);
	out[0] = marker;
	out.set(bytes, 1);
	return out;
}

function withoutMarker(bytes, marker) {
	return bytes[0] === marker ? bytes.slice(1) : bytes;
}

function makeCommand(cmd, strategy) {
	const body = blank(strategy.includeMarker ? SHORT_LEN : SHORT_LEN - 1);
	if (strategy.includeMarker) {
		body[0] = MARK_READ;
		body[1] = cmd;
	} else {
		body[0] = cmd;
	}
	return body;
}

async function sendCommand(cmd, strategy) {
	await device.sendFeatureReport(strategy.commandReport, makeCommand(cmd, strategy));
}

async function readFeature(strategy, marker = MARK_READ) {
	const data = await device.receiveFeatureReport(strategy.receiveReport);
	return withMarker(new Uint8Array(data.buffer), marker);
}

async function tryReadWith(strategy) {
	await sendCommand(CMD_IDENT, strategy);
	await sleep(40);
	const ident = await readFeature(strategy, MARK_READ);
	if (ident[0] !== MARK_READ || ident[1] !== 0x01) {
		throw new Error("Unexpected identity response");
	}

	await sendCommand(CMD_GET, strategy);
	await sleep(70);
	const blob = await readFeature(strategy, MARK_READ);
	if (blob.length < 120 || blob[0] !== MARK_READ || blob[1] !== 0x01) {
		throw new Error("Unexpected profile response");
	}
	return { ident, blob };
}

async function readFromMouse() {
	if (!device) return;
	setBusy(true, "Reading...");
	const errors = [];

	try {
		const candidates = transport ? [transport, ...strategies.filter((s) => s !== transport)] : strategies;
		for (const strategy of candidates) {
			try {
				const { ident, blob } = await tryReadWith(strategy);
				transport = strategy;
				rawProfile = normalizeProfileLength(blob);
				parseProfile(rawProfile);
				els.fw.textContent = `${ident[18] ?? 0}.${String(ident[17] ?? 0).padStart(2, "0")}`;
				render();
				markClean();
				toast("Profile read from mouse.", "success");
				setBusy(false, "Connected");
				return;
			} catch (error) {
				errors.push(`${strategy.name}: ${error.message}`);
			}
		}
		throw new Error(errors.join(" | "));
	} catch (error) {
		setBusy(false, "Connected, read failed");
		els.statusDot.classList.add("error");
		toast(`Read failed: ${error.message}`, "error");
	}
}

function normalizeProfileLength(blob) {
	if (blob.length === PROFILE_LEN) return blob;
	const out = blank(PROFILE_LEN);
	out.set(blob.slice(0, PROFILE_LEN));
	return out;
}

async function writeToMouse() {
	if (!device || !rawProfile) return;
	setBusy(true, "Applying...");

	try {
		const blob = buildProfile();
		const active = transport ?? strategies[0];
		const payload = active.includeMarker ? blob : withoutMarker(blob, MARK_WRITE);
		await device.sendFeatureReport(active.writeReport, payload);
		await sleep(80);

		try {
			await readFeature(active, MARK_READ);
		} catch {
			// Some browsers/devices do not expose the short acknowledgement after SET_REPORT.
		}

		rawProfile = blob;
		markClean();
		toast("Settings applied to mouse.", "success");
		await readFromMouse();
	} catch (error) {
		toast(`Apply failed: ${error.message}`, "error");
		setBusy(false, "Connected, apply failed");
	}
}

function readU16LE(bytes, offset) {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function writeU16LE(bytes, offset, value) {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >> 8) & 0xff;
}

function isBinary(bytes, offset) {
	return bytes[offset] === 0x00 || bytes[offset] === 0x01;
}

function parseProfile(bytes) {
	const next = structuredClone(defaultProfile);

	next.cpiCount = clamp(bytes[OFFSETS.cpiCount] || 4, 1, 4);
	next.pollingHz = POLL_FROM_CODE.get(bytes[OFFSETS.polling]) ?? 1000;

	for (let i = 0; i < 4; i += 1) {
		const offset = CPI_OFFSETS[i];
		next.cpi[i][0] = clampCpi(readU16LE(bytes, offset));
		next.cpi[i][1] = clampCpi(readU16LE(bytes, offset + 2));
	}

	if (isBinary(bytes, OFFSETS.motionSync)) next.motionSync = bytes[OFFSETS.motionSync] === 1;
	if (isBinary(bytes, OFFSETS.angleSnap)) next.angleSnap = bytes[OFFSETS.angleSnap] === 1;
	if (isBinary(bytes, OFFSETS.ripple)) next.ripple = bytes[OFFSETS.ripple] === 1;
	if (isBinary(bytes, OFFSETS.liftLed)) next.liftLed = bytes[OFFSETS.liftLed] === 0;
	if (isBinary(bytes, OFFSETS.glassMode)) next.glassMode = bytes[OFFSETS.glassMode] === 1;
	if (isBinary(bytes, OFFSETS.forceMaxSensorFps)) next.forceMaxSensorFps = bytes[OFFSETS.forceMaxSensorFps] === 1;
	if (isBinary(bytes, OFFSETS.slamclick)) next.slamclick = bytes[OFFSETS.slamclick] === 1;
	next.lod = decodeLod(bytes[OFFSETS.lod], next.glassMode);
	next.filters.left = bytes[OFFSETS.leftFilter] || 0;
	next.filters.right = bytes[OFFSETS.rightFilter] || 0;
	next.filters.middle = clamp(bytes[OFFSETS.middleFilter] || 0, 0, 25);
	next.filters.forward = clamp(bytes[OFFSETS.forwardFilter] || 0, 0, 25);
	next.filters.back = clamp(bytes[OFFSETS.backFilter] || 0, 0, 25);

	profile = next;
	if (profile.filters.left <= 25) lastFilterValues.left = profile.filters.left;
	if (profile.filters.right <= 25) lastFilterValues.right = profile.filters.right;

	let splitDetected = false;
	for (let i = 0; i < profile.cpiCount; i++) {
		if (profile.cpi[i][0] !== profile.cpi[i][1]) {
			splitDetected = true;
			break;
		}
	}
	cpiXySplit = splitDetected;

	lodTouched = false;
}

function buildProfile() {
	const bytes = rawProfile ? new Uint8Array(rawProfile) : blank(PROFILE_LEN);
	bytes[0] = MARK_WRITE;
	bytes[1] = CMD_SET;

	bytes[OFFSETS.cpiCount] = profile.cpiCount;
	bytes[OFFSETS.polling] = CODE_FROM_POLL.get(profile.pollingHz) ?? 0x08;
	if (lodTouched || !rawProfile) {
		bytes[OFFSETS.lod] = encodeLod(profile.lod, profile.glassMode);
	}

	for (let i = 0; i < 4; i += 1) {
		const offset = CPI_OFFSETS[i];
		writeU16LE(bytes, offset, clampCpi(profile.cpi[i][0]));
		writeU16LE(bytes, offset + 2, clampCpi(profile.cpi[i][1]));
	}

	writeIfBinarySlot(bytes, OFFSETS.motionSync, profile.motionSync);
	writeIfBinarySlot(bytes, OFFSETS.angleSnap, profile.angleSnap);
	writeIfBinarySlot(bytes, OFFSETS.ripple, profile.ripple);
	writeIfBinarySlot(bytes, OFFSETS.liftLed, !profile.liftLed);
	writeIfBinarySlot(bytes, OFFSETS.glassMode, profile.glassMode);
	writeIfBinarySlot(bytes, OFFSETS.forceMaxSensorFps, profile.forceMaxSensorFps);
	writeIfBinarySlot(bytes, OFFSETS.slamclick, profile.slamclick);
	bytes[OFFSETS.leftFilter] = profile.filters.left;
	bytes[OFFSETS.rightFilter] = profile.filters.right;
	bytes[OFFSETS.middleFilter] = clamp(profile.filters.middle, 0, 25);
	bytes[OFFSETS.forwardFilter] = clamp(profile.filters.forward, 0, 25);
	bytes[OFFSETS.backFilter] = clamp(profile.filters.back, 0, 25);
	bytes[OFFSETS.acceptMulticlick] = 0x01;

	return bytes;
}

function writeIfBinarySlot(bytes, offset, enabled) {
	if (isBinary(bytes, offset)) bytes[offset] = enabled ? 1 : 0;
}

async function connectMouse() {
	if (!navigator.hid) {
		els.webhidWarning.hidden = false;
		toast("WebHID is not available in this browser.", "error");
		return;
	}

	try {
		const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: VID, productId: PID }] });
		if (!devices.length) return;
		device = devices[0];
		if (!device.opened) await device.open();
		setConnected(true);
		await readFromMouse();
	} catch (error) {
		toast(`Connection failed: ${error.message}`, "error");
	}
}

async function disconnectMouse() {
	if (device?.opened) await device.close();
	device = null;
	rawProfile = null;
	transport = null;
	setConnected(false);
}

function setConnected(connected) {
	els.statusDot.classList.toggle("connected", connected);
	els.statusDot.classList.remove("error");
	els.statusText.textContent = connected ? "Connected" : "Not connected";
	els.connect.textContent = connected ? "Disconnect" : "Connect";
	els.configPanel.hidden = !connected;
	els.actionbar.hidden = !connected;
	[els.apply, els.read, els.reset].forEach((el) => {
		el.disabled = !connected;
	});
	if (!connected) {
		els.fw.textContent = "unknown";
		markClean();
	}
}

function setBusy(busy, text) {
	[els.apply, els.read, els.reset, els.connect].forEach((el) => {
		el.disabled = busy;
	});
	els.statusText.textContent = text;
}

function render() {
	els.cpiCount.value = profile.cpiCount;
	els.cpiCount.textContent = profile.cpiCount;
	$("cpi-xy-split").checked = cpiXySplit;
	renderCpiList();
	renderButtons("#polling-group button", "rate", profile.pollingHz);
	renderLodButtons();
	$("motion-sync").checked = profile.motionSync;
	$("angle-snap").checked = profile.angleSnap;
	$("ripple-control").checked = profile.ripple;
	$("lift-led").checked = profile.liftLed;
	$("glass-mode").checked = profile.glassMode;
	$("force-max-fps").checked = profile.forceMaxSensorFps;
	$("slamclick").checked = profile.slamclick;
	renderSpdtControl("left", profile.filters.left);
	renderSpdtControl("right", profile.filters.right);
	$("middle-filter").value = profile.filters.middle;
	$("forward-filter").value = profile.filters.forward;
	$("back-filter").value = profile.filters.back;
}

function renderButtons(selector, dataName, activeValue) {
	document.querySelectorAll(selector).forEach((button) => {
		const value = Number(button.dataset[dataName]);
		button.classList.toggle("active", Math.abs(value - activeValue) < 0.01);
	});
}

function renderLodButtons() {
	const values = getLodValues(profile.glassMode);
	document.querySelectorAll("#lod-group button").forEach((button) => {
		const value = Number(button.dataset.lod);
		const supported = values.some((item) => Math.abs(item - value) < 0.01);
		button.hidden = !supported;
		button.classList.toggle("active", supported && Math.abs(value - profile.lod) < 0.01);
	});
}

function renderSpdtControl(side, rawValue) {
	const mode = rawValue === 0xf1 ? "speed" : rawValue === 0xf0 ? "safe" : "off";
	const isOff = mode === "off";
	const filterValue = isOff ? clamp(rawValue, 0, 25) : lastFilterValues[side];

	$(`${side}-spdt`).value = mode;

	const filterInput = $(`${side}-filter`);
	filterInput.value = filterValue;
	filterInput.disabled = !isOff;

	const filterNumberInput = $(`${side}-filter-number`);
	filterNumberInput.value = filterValue;
	filterNumberInput.disabled = !isOff;

	const filterWrap = $(`${side}-filter-wrap`);
	filterWrap.hidden = false;
	filterWrap.classList.toggle("disabled", !isOff);
}

function renderCpiList() {
	els.cpiList.innerHTML = "";
	for (let i = 0; i < 4; i += 1) {
		if (i >= profile.cpiCount) continue;
		const [x, y] = profile.cpi[i];
		const row = document.createElement("article");
		row.className = "cpi-row";

		if (cpiXySplit) {
			row.innerHTML = `
				<div class="cpi-row-head">
					<strong>Level ${i + 1}</strong>
					<span class="cpi-value">${formatCpi(x, y)}</span>
				</div>
				<div class="cpi-axis-group">
					<div class="cpi-axis-row">
						<span class="cpi-axis-label">X</span>
						<input class="cpi-slider" type="range" min="10" max="30000" step="10" value="${x}" data-cpi-slider-x="${i}">
						<input type="number" min="10" max="30000" step="10" value="${x}" data-cpi-x="${i}" class="cpi-number-input">
					</div>
					<div class="cpi-axis-row">
						<span class="cpi-axis-label">Y</span>
						<input class="cpi-slider" type="range" min="10" max="30000" step="10" value="${y}" data-cpi-slider-y="${i}">
						<input type="number" min="10" max="30000" step="10" value="${y}" data-cpi-y="${i}" class="cpi-number-input">
					</div>
				</div>
			`;
		} else {
			row.innerHTML = `
				<div class="cpi-row-head">
					<strong>Level ${i + 1}</strong>
					<span class="cpi-value">${formatCpi(x, x)}</span>
				</div>
				<div class="cpi-axis-row">
					<input class="cpi-slider" type="range" min="10" max="30000" step="10" value="${x}" data-cpi-slider-xy="${i}">
					<input type="number" min="10" max="30000" step="10" value="${x}" data-cpi-xy="${i}" class="cpi-number-input">
				</div>
			`;
		}
		els.cpiList.appendChild(row);
	}
}

function populateFilterSelects() {
	const options = [
		["off", "Off"],
		["speed", "GX Speed Mode"],
		["safe", "GX Safe mode"],
	];
	for (const id of ["left-spdt", "right-spdt"]) {
		const select = $(id);
		select.innerHTML = "";
		for (const [value, label] of options) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = label;
			select.appendChild(option);
		}
	}
}

function formatCpi(x, y) {
	return x === y ? `${x.toLocaleString()} CPI` : `${x.toLocaleString()} / ${y.toLocaleString()} CPI`;
}

function markDirty() {
	dirty = true;
	els.dirty.textContent = "Unsaved changes";
	els.dirty.classList.add("dirty");
}

function markClean() {
	dirty = false;
	els.dirty.textContent = "Saved";
	els.dirty.classList.remove("dirty");
}

function toast(message, type = "info") {
	const item = document.createElement("div");
	item.className = `toast ${type}`;
	item.textContent = message;
	$("toast-stack").appendChild(item);
	setTimeout(() => item.remove(), 4500);
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, Number(value) || min));
}

function clampCpi(value) {
	return clamp(Math.round((Number(value) || 10) / 10) * 10, 10, 30000);
}

function getLodValues(glassMode) {
	return glassMode ? GLASS_LOD_VALUES : LOD_VALUES;
}

function encodeLod(lod, glassMode) {
	if (glassMode) return CODE_FROM_GLASS_LOD.get(lod) ?? 0x01;
	const values = getLodValues(glassMode);
	const index = values.findIndex((value) => Math.abs(value - lod) < 0.01);
	return Math.max(0, index);
}

function decodeLod(code, glassMode) {
	if (glassMode) return GLASS_LOD_FROM_CODE.get(code) ?? 1.0;
	return LOD_VALUES[code] ?? 0.7;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateCpi(index, x, y = x) {
	profile.cpi[index][0] = clampCpi(x);
	profile.cpi[index][1] = clampCpi(y);
	render();
	markDirty();
}

async function resetDefaults() {
	if (!device || !rawProfile) {
		toast("Connect and read the mouse before resetting.", "error");
		return;
	}
	profile = structuredClone(defaultProfile);
	lastFilterValues = { left: 8, right: 8 };
	lodTouched = true;
	render();
	markDirty();
	toast("Writing factory defaults to the mouse...");
	await writeToMouse();
}

function bindEvents() {
	els.connect.addEventListener("click", () => (device?.opened ? disconnectMouse() : connectMouse()));
	els.read.addEventListener("click", readFromMouse);
	els.apply.addEventListener("click", writeToMouse);
	els.reset.addEventListener("click", resetDefaults);

	$("cpi-count-plus").addEventListener("click", () => {
		profile.cpiCount = clamp(profile.cpiCount + 1, 1, 4);
		render();
		markDirty();
	});
	$("cpi-count-minus").addEventListener("click", () => {
		profile.cpiCount = clamp(profile.cpiCount - 1, 1, 4);
		render();
		markDirty();
	});

	$("polling-group").addEventListener("click", (event) => {
		const button = event.target.closest("button[data-rate]");
		if (!button) return;
		profile.pollingHz = Number(button.dataset.rate);
		render();
		markDirty();
	});

	$("lod-group").addEventListener("click", (event) => {
		const button = event.target.closest("button[data-lod]");
		if (!button) return;
		profile.lod = Number(button.dataset.lod);
		lodTouched = true;
		render();
		markDirty();
	});

	els.cpiList.addEventListener("input", (event) => {
		const sliderXy = event.target.closest("[data-cpi-slider-xy]");
		const sliderX = event.target.closest("[data-cpi-slider-x]");
		const sliderY = event.target.closest("[data-cpi-slider-y]");

		if (sliderXy) {
			const index = Number(sliderXy.dataset.cpiSliderXy);
			updateCpi(index, sliderXy.value, sliderXy.value);
		} else if (sliderX) {
			const index = Number(sliderX.dataset.cpiSliderX);
			updateCpi(index, sliderX.value, profile.cpi[index][1]);
		} else if (sliderY) {
			const index = Number(sliderY.dataset.cpiSliderY);
			updateCpi(index, profile.cpi[index][0], sliderY.value);
		}
	});

	els.cpiList.addEventListener("change", (event) => {
		const xyInput = event.target.closest("[data-cpi-xy]");
		const xInput = event.target.closest("[data-cpi-x]");
		const yInput = event.target.closest("[data-cpi-y]");

		if (xyInput) {
			const index = Number(xyInput.dataset.cpiXy);
			updateCpi(index, xyInput.value, xyInput.value);
		} else if (xInput) {
			const index = Number(xInput.dataset.cpiX);
			updateCpi(index, xInput.value, profile.cpi[index][1]);
		} else if (yInput) {
			const index = Number(yInput.dataset.cpiY);
			updateCpi(index, profile.cpi[index][0], yInput.value);
		}
	});

	$("cpi-xy-split").addEventListener("change", (event) => {
		cpiXySplit = event.target.checked;
		if (!cpiXySplit) {
			for (let i = 0; i < 4; i++) {
				profile.cpi[i][1] = profile.cpi[i][0];
			}
			markDirty();
		}
		render();
	});

	const checkboxMap = [
		["motion-sync", "motionSync"],
		["angle-snap", "angleSnap"],
		["ripple-control", "ripple"],
		["lift-led", "liftLed"],
		["glass-mode", "glassMode"],
		["force-max-fps", "forceMaxSensorFps"],
		["slamclick", "slamclick"],
	];
	for (const [id, key] of checkboxMap) {
		$(id).addEventListener("change", (event) => {
			const wasGlassMode = profile.glassMode;
			profile[key] = event.target.checked;
			if (key === "glassMode") {
				const values = getLodValues(profile.glassMode);
				if (profile.glassMode && !wasGlassMode) {
					profile.lod = values[0];
				} else if (!values.some((value) => Math.abs(value - profile.lod) < 0.01)) {
					profile.lod = values[0];
				}
				render();
			}
			markDirty();
		});
	}

	const spdtMap = [
		["left-spdt", "left"],
		["right-spdt", "right"],
	];
	for (const [id, key] of spdtMap) {
		$(id).addEventListener("change", (event) => {
			if (event.target.value === "speed") profile.filters[key] = 0xf1;
			if (event.target.value === "safe") profile.filters[key] = 0xf0;
			if (event.target.value === "off") profile.filters[key] = lastFilterValues[key];
			render();
			markDirty();
		});
	}

	const rangeMap = [
		["left-filter", "left"],
		["right-filter", "right"],
	];
	for (const [id, key] of rangeMap) {
		$(id).addEventListener("input", (event) => {
			const val = clamp(event.target.value, 0, 25);
			profile.filters[key] = val;
			lastFilterValues[key] = val;
			$(`${key}-filter-number`).value = val;
			markDirty();
		});

		$(`${id}-number`).addEventListener("input", (event) => {
			const val = clamp(event.target.value, 0, 25);
			profile.filters[key] = val;
			lastFilterValues[key] = val;
			$(id).value = val;
			markDirty();
		});
	}

	const filterMap = [
		["middle-filter", "middle"],
		["forward-filter", "forward"],
		["back-filter", "back"],
	];
	for (const [id, key] of filterMap) {
		$(id).addEventListener("change", (event) => {
			profile.filters[key] = Number(event.target.value);
			markDirty();
		});
	}

	if (navigator.hid) {
		navigator.hid.addEventListener("disconnect", ({ device: disconnected }) => {
			if (disconnected === device) disconnectMouse();
		});
	}
}

async function autoReconnect() {
	if (!navigator.hid) return;
	const devices = await navigator.hid.getDevices();
	const match = devices.find((item) => item.vendorId === VID && item.productId === PID);
	if (!match) return;
	try {
		device = match;
		if (!device.opened) await device.open();
		setConnected(true);
		await readFromMouse();
	} catch {
		device = null;
		setConnected(false);
	}
}

function bindTabs() {
	const tabButtons = document.querySelectorAll(".tab-btn");
	const tabPanels = document.querySelectorAll(".tab-panel");

	tabButtons.forEach((btn) => {
		btn.addEventListener("click", () => {
			const targetTab = btn.dataset.tab;

			tabButtons.forEach((b) => {
				const isActive = b === btn;
				b.classList.toggle("active", isActive);
				b.setAttribute("aria-selected", isActive ? "true" : "false");
			});

			tabPanels.forEach((panel) => {
				const isTarget = panel.id === targetTab;
				panel.hidden = !isTarget;
			});
		});
	});
}

function init() {
	populateFilterSelects();
	render();
	bindEvents();
	bindTabs();
	setConnected(false);
	if (!navigator.hid) {
		els.webhidWarning.hidden = false;
		els.connect.disabled = true;
	} else {
		autoReconnect();
	}
}

init();
