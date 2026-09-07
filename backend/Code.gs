/**
 * Thermolog – Google Apps Script backend
 *
 * Serves the dashboard's data endpoints, maps sensor readings to the unit they
 * belong to, and owns alarm delivery. The browser can only dispatch while
 * someone has the page open, which is not when a compressor fails at 03:00;
 * checkAlarms() runs on a time-driven trigger instead and is the authority on
 * what gets sent.
 *
 * Setup
 *   1. Create a spreadsheet with the sheets described in SHEETS below.
 *   2. Extensions > Apps Script, paste this file, set the constants.
 *   3. Deploy > New deployment > Web app, execute as yourself, access to
 *      anyone with the link. Put that URL in API_URL in index.html.
 *   4. Triggers > Add trigger > checkAlarms > time-driven > every 5 minutes.
 *   5. Point the hub's webhook at the same URL, posting
 *      { action: 'reading', device_id, ts, temp_c }.
 */

/* ---------- Configuration ---------- */

var SPREADSHEET_ID = '';          /* leave empty to use the bound spreadsheet */
var STORE_NAME = 'Demo store';

/* Escalation ladder in minutes from the start of the alarm, one entry per
   level. Keep these in step with NOTIFY_LADDER_MIN in index.html. */
var LADDER_MIN = [0, 20];
var REPEAT_MIN = 30;
var MAX_REPEATS = 3;

/* No reading for this long means the sensor has lost contact. */
var STALE_AFTER_MIN = 60;

/* SMS gateway. Left empty, SMS recipients are logged but not sent.
   Fill in for a provider that accepts a JSON POST (Twilio, MessageBird, ...). */
var SMS_ENDPOINT = '';
var SMS_AUTH_HEADER = '';

var SHEETS = {
  /* id | device_id | name_el | name_en | department_el | department_en |
     category_ids | tolerance_c | override_min_c | override_max_c |
     override_reason | sensor_model | sensor_serial | sensor_standard |
     last_verification | next_verification
     category_ids holds one or more category ids separated by commas. */
  units: 'Units',

  /* id | name_el | name_en | min_c | max_c | legal_ref_el | legal_ref_en
     The critical limits live here once and are inherited by every unit. */
  categories: 'Categories',

  readings: 'Readings',            /* unit_id | ts | temp_c */
  recipients: 'Recipients',        /* id | name | role_el | role_en | channel | address | level */
  actions: 'Actions',              /* unit_id | deviation_start | text | person | at */
  notifications: 'Notifications',  /* at | unit_id | alarm_key | level | cause | channel |
                                      address | status | detail */

  /* device_id | first_seen | last_seen | readings
     Sensors that have joined the hub but are not yet assigned to a unit.
     This is the commissioning list: power a sensor, watch it appear here. */
  unmapped: 'Unmapped'
};

/* ---------- HTTP ---------- */

function doGet(e) {
  var type = (e && e.parameter && e.parameter.type) || 'units';

  if (type === 'units') return json(readUnits());
  if (type === 'categories') return json(readCategories());
  if (type === 'readings') return json(readReadings());
  if (type === 'recipients') return json(readRecipients());
  if (type === 'notifications') return json(rows(SHEETS.notifications));
  if (type === 'unmapped') return json(rows(SHEETS.unmapped));

  return json({ error: 'unknown type: ' + type });
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json({ error: 'invalid JSON' }); }

  if (body.action === 'reading') return json(ingest([body]));
  if (body.action === 'readings') return json(ingest(body.readings || []));

  if (body.action === 'corrective_action') {
    sheet(SHEETS.actions).appendRow([
      body.unit_id, body.deviation_start, body.text, body.person, new Date()
    ]);
    return json({ ok: true });
  }

  if (body.action === 'save_units') {
    writeUnits(body.units || []);
    return json({ ok: true });
  }

  if (body.action === 'save_categories') {
    writeCategories(body.categories || []);
    return json({ ok: true });
  }

  /* Dispatch requested by the page. Accepted so a demo can drive delivery from
     the browser, but production alarms come from checkAlarms() below. */
  if (body.action === 'notify') {
    var status = send(body.channel, body.address, body.subject, body.body);
    logNotification(body.unit_id, body.alarm_key, body.level, body.cause,
                    body.channel, body.address, status, body.body);
    return json({ ok: status === 'sent', status: status });
  }

  return json({ error: 'unknown action: ' + body.action });
}

/* ---------- Ingesting readings from the hub ----------
   The hub knows only the sensor's own id (a LoRaWAN DevEUI, say). Resolving
   that to a unit is what connects a physical sensor to a named freezer, and it
   is the one step that has to happen before any reading means anything. */

function ingest(items) {
  if (!items.length) return { ok: true, stored: 0 };

  var byDevice = {};
  readUnits().forEach(function (u) {
    if (u.device_id) byDevice[String(u.device_id).trim().toUpperCase()] = u.id;
  });

  var accepted = [], unknown = [];

  items.forEach(function (item) {
    var device = String(item.device_id || '').trim().toUpperCase();
    var unitId = byDevice[device];

    if (!unitId) { unknown.push(device); return; }

    accepted.push([
      unitId,
      item.ts ? new Date(item.ts) : new Date(),
      Number(item.temp_c)
    ]);
  });

  if (accepted.length) {
    var sh = sheet(SHEETS.readings);
    sh.getRange(sh.getLastRow() + 1, 1, accepted.length, 3).setValues(accepted);
  }

  unknown.forEach(noteUnmapped);

  return { ok: true, stored: accepted.length, unmapped: unknown };
}

/* Records a sensor that is reporting but is not assigned to any unit, so it can
   be found and mapped rather than silently discarded. */
function noteUnmapped(deviceId) {
  var sh = sheet(SHEETS.unmapped);
  var values = sh.getDataRange().getValues();

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim().toUpperCase() === deviceId) {
      sh.getRange(i + 1, 3).setValue(new Date());
      sh.getRange(i + 1, 4).setValue(Number(values[i][3] || 0) + 1);
      return;
    }
  }

  sh.appendRow([deviceId, new Date(), new Date(), 1]);
}

/* ---------- Limit derivation ----------
   Mirrors resolveLimits() in index.html. Where several categories share a
   cabinet the strictest bound of each side wins: chilled poultry beside fresh
   meat is a 4 °C unit, not a 7 °C one. */

function resolveLimits(unit, categories) {
  if (unit.override && unit.override.reason) {
    return { min_c: Number(unit.override.min_c), max_c: Number(unit.override.max_c),
             tolerance_c: Number(unit.tolerance_c || 0), source: 'override' };
  }

  var cats = (unit.category_ids || []).map(function (id) {
    return categories.filter(function (c) { return c.id === id; })[0];
  }).filter(Boolean);

  if (!cats.length) return null;

  var min_c = Math.max.apply(null, cats.map(function (c) { return c.min_c; }));
  var max_c = Math.min.apply(null, cats.map(function (c) { return c.max_c; }));

  if (min_c > max_c) return null;   /* incompatible categories */

  return { min_c: min_c, max_c: max_c,
           tolerance_c: Number(unit.tolerance_c || 0), source: 'category' };
}

/* ---------- Alarm evaluation (the part that must not depend on a browser) ---------- */

function checkAlarms() {
  var units = readUnits();
  var categories = readCategories();
  var readings = readReadings();
  var recipients = readRecipients();
  var actions = rows(SHEETS.actions);
  var sent = rows(SHEETS.notifications);
  var now = new Date().getTime();

  units.forEach(function (unit) {
    var limits = resolveLimits(unit, categories);
    if (!limits) {
      console.warn('Unit has no usable limits, skipping: ' + unit.id);
      return;
    }

    var series = readings
      .filter(function (r) { return r.unit_id === unit.id; })
      .map(function (r) { return { t: new Date(r.ts).getTime(), temp_c: Number(r.temp_c) }; })
      .sort(function (a, b) { return a.t - b.t; });

    if (!series.length) return;

    var last = series[series.length - 1];
    var state = null;

    if ((now - last.t) / 60000 > STALE_AFTER_MIN) {
      state = {
        key: unit.id + ':stale:' + last.t,
        start: last.t + STALE_AFTER_MIN * 60000,
        cause: 'stale',
        detail: 'No reading since ' + new Date(last.t).toISOString()
      };
    } else {
      var open = openDeviation(limits, series);
      if (open) {
        var closed = actions.some(function (a) {
          return a.unit_id === unit.id &&
                 new Date(a.deviation_start).getTime() === open.start;
        });
        if (closed) return;

        state = {
          key: unit.id + ':' + open.start,
          start: open.start,
          cause: 'alarm',
          detail: 'Outside limits ' + limits.min_c + ' to ' + limits.max_c +
                  ' °C, peak ' + open.extreme.toFixed(1) + ' °C'
        };
      }
    }

    if (!state) return;

    var elapsed = (now - state.start) / 60000;

    LADDER_MIN.forEach(function (afterMin, i) {
      var level = i + 1;
      if (elapsed < afterMin) return;

      var atLevel = recipients.filter(function (r) { return Number(r.level) === level; });
      if (!atLevel.length) return;

      var prior = sent.filter(function (n) {
        return n.alarm_key === state.key && Number(n.level) === level;
      });
      if (prior.length >= MAX_REPEATS * atLevel.length) return;

      var lastAt = prior.reduce(function (max, n) {
        return Math.max(max, new Date(n.at).getTime());
      }, 0);
      if (lastAt && (now - lastAt) / 60000 < REPEAT_MIN) return;

      atLevel.forEach(function (r) {
        var subject = '[' + STORE_NAME + '] ' + unit.name_en + ' – ' +
                      (state.cause === 'stale' ? 'loss of contact' : 'temperature alarm');
        var status = send(r.channel, r.address, subject, state.detail);
        logNotification(unit.id, state.key, level, state.cause,
                        r.channel, r.address, status, state.detail);
      });
    });
  });
}

/* Trailing run of readings outside the limits, if the unit is in one. */
function openDeviation(limits, series) {
  var start = null, extreme = null;

  for (var i = series.length - 1; i >= 0; i--) {
    var temp = series[i].temp_c;
    if (temp >= limits.min_c && temp <= limits.max_c) break;
    start = series[i].t;
    if (extreme === null ||
        (temp > limits.max_c && temp > extreme) ||
        (temp < limits.min_c && temp < extreme)) extreme = temp;
  }

  return start === null ? null : { start: start, extreme: extreme };
}

/* ---------- Delivery ---------- */

function send(channel, address, subject, body) {
  try {
    if (channel === 'email') {
      MailApp.sendEmail({ to: address, subject: subject, body: body });
      return 'sent';
    }

    if (channel === 'sms') {
      if (!SMS_ENDPOINT) return 'skipped';
      var headers = SMS_AUTH_HEADER ? { Authorization: SMS_AUTH_HEADER } : {};
      UrlFetchApp.fetch(SMS_ENDPOINT, {
        method: 'post',
        contentType: 'application/json',
        headers: headers,
        muteHttpExceptions: true,
        payload: JSON.stringify({ to: address, text: subject + ' – ' + body })
      });
      return 'sent';
    }
  } catch (err) {
    console.error('delivery failed', channel, address, err);
    return 'failed';
  }

  return 'failed';
}

function logNotification(unitId, key, level, cause, channel, address, status, detail) {
  sheet(SHEETS.notifications).appendRow([
    new Date(), unitId, key, level, cause, channel, address, status, detail
  ]);
}

/* ---------- Sheet access ---------- */

function book() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID)
                        : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet(name) {
  var sh = book().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet: ' + name);
  return sh;
}

/* Reads a sheet into objects keyed by its header row. */
function rows(name) {
  var values = sheet(name).getDataRange().getValues();
  if (values.length < 2) return [];

  var header = values[0].map(String);
  return values.slice(1)
    .filter(function (row) { return String(row[0]).length > 0; })
    .map(function (row) {
      var obj = {};
      header.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
}

function readCategories() {
  return rows(SHEETS.categories).map(function (c) {
    return {
      id: String(c.id),
      name: { el: c.name_el, en: c.name_en },
      min_c: Number(c.min_c),
      max_c: Number(c.max_c),
      legal_ref: { el: c.legal_ref_el, en: c.legal_ref_en }
    };
  });
}

function readUnits() {
  return rows(SHEETS.units).map(function (u) {
    var override = String(u.override_reason || '').trim()
      ? { min_c: Number(u.override_min_c), max_c: Number(u.override_max_c),
          reason: String(u.override_reason) }
      : null;

    return {
      id: String(u.id),
      device_id: String(u.device_id || ''),
      name: { el: u.name_el, en: u.name_en },
      name_en: u.name_en,
      department: { el: u.department_el, en: u.department_en },
      category_ids: String(u.category_ids || '').split(',')
        .map(function (x) { return x.trim(); })
        .filter(Boolean),
      tolerance_c: Number(u.tolerance_c || 0),
      override: override,
      sensor: {
        model: u.sensor_model,
        serial: u.sensor_serial,
        standard: u.sensor_standard,
        last_verification: fmtDate(u.last_verification),
        next_verification: fmtDate(u.next_verification)
      }
    };
  });
}

function readReadings() {
  return rows(SHEETS.readings).map(function (r) {
    return {
      unit_id: String(r.unit_id),
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      temp_c: Number(r.temp_c)
    };
  });
}

function readRecipients() {
  return rows(SHEETS.recipients).map(function (r) {
    return {
      id: String(r.id),
      name: r.name,
      role: { el: r.role_el, en: r.role_en },
      channel: String(r.channel).toLowerCase(),
      address: String(r.address),
      level: Number(r.level)
    };
  });
}

/* Replaces the sheet contents below the header row. */
function replaceRows(name, values) {
  var sh = sheet(name);
  var lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).clearContent();
  if (values.length) sh.getRange(2, 1, values.length, values[0].length).setValues(values);
}

function writeUnits(units) {
  replaceRows(SHEETS.units, units.map(function (u) {
    var name = u.name || {}, dept = u.department || {},
        ov = u.override || {}, sn = u.sensor || {};
    return [
      u.id, u.device_id || '',
      name.el || u.name || '', name.en || u.name || '',
      dept.el || u.department || '', dept.en || u.department || '',
      (u.category_ids || []).join(','),
      Number(u.tolerance_c || 0),
      ov.min_c === undefined ? '' : ov.min_c,
      ov.max_c === undefined ? '' : ov.max_c,
      ov.reason || '',
      sn.model || '', sn.serial || '', sn.standard || '',
      sn.last_verification || '', sn.next_verification || ''
    ];
  }));
}

function writeCategories(categories) {
  replaceRows(SHEETS.categories, categories.map(function (c) {
    var name = c.name || {}, ref = c.legal_ref || {};
    return [
      c.id,
      name.el || c.name || '', name.en || c.name || '',
      Number(c.min_c), Number(c.max_c),
      ref.el || c.legal_ref || '', ref.en || c.legal_ref || ''
    ];
  }));
}

function fmtDate(v) {
  if (!v) return '';
  return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
                           : String(v);
}

function json(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
