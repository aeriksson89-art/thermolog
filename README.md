# Thermolog

Temperature monitoring for supermarket refrigeration: sensors report to a hub,
the app evaluates every reading against the legal critical limits, raises alarms,
records the corrective action taken, and produces a compliance report for
inspection.

Built as a demo for the Cypriot market. The interface is available in **Greek**
and **English**, switchable from the selector in the top right.

## Running it

Open `index.html` in a browser. With no backend configured the app starts in
**demo mode** with 30 days of simulated data across seven units, including three
deliberate scenarios: a frozen display cabinet drifting out of limits right now,
a short excursion during a delivery five days ago, and a sensor that has lost
contact.

## Connecting the hub

Set `API_URL` at the top of the script section to your endpoint. Text fields may
be plain strings or `{ el, en }` objects for bilingual output.

**`GET ?type=units`**

```json
[
  {
    "id": "fr1",
    "name": { "el": "Βιτρίνα κατεψυγμένων 1", "en": "Frozen display cabinet 1" },
    "department": { "el": "Κατεψυγμένα", "en": "Frozen foods" },
    "min_c": -30,
    "max_c": -18,
    "tolerance_c": 3,
    "legal_ref": { "el": "Οδηγία 89/108/ΕΟΚ …", "en": "Directive 89/108/EEC …" },
    "sensor": {
      "model": "Milesight EM500-PT100",
      "serial": "TL-24-0117",
      "standard": "EN 12830 · class 1",
      "last_verification": "2026-03-14",
      "next_verification": "2027-03-14"
    }
  }
]
```

**`GET ?type=readings`**

```json
[{ "unit_id": "fr1", "ts": "2026-09-07T08:15:00Z", "temp_c": -19.4 }]
```

**`POST`** — corrective actions:

```json
{ "action": "corrective_action", "unit_id": "fr1",
  "deviation_start": "2026-09-07T09:02:00Z", "text": "…", "person": "…" }
```

In demo mode corrective actions are kept in `localStorage` so the flow can be
demonstrated without a backend.

## Settings

All constants sit at the top of the script section:

| Constant | Default | Meaning |
| --- | --- | --- |
| `API_URL` | `''` | Data endpoint. Empty string = demo mode. |
| `STORE_NAME` / `STORE_ADDRESS` | demo values | Shown in the header and on the report. |
| `OPERATOR_NAME` | demo value | Named as responsible on the report. |
| `WARN_MARGIN_C` | `1.0` | Margin to the critical limit that triggers a warning. |
| `ALARM_GRACE_MIN` | `30` | How long a unit may sit outside limits before the deviation escalates to an alarm. |
| `STALE_AFTER_MIN` | `60` | No reading for this long means the sensor has lost contact. |
| `REFRESH_INTERVAL_S` | `60` | Automatic refresh. `0` disables it. |
| `RETENTION_DAYS` | `365` | Retention stated on the report. |

`ALARM_GRACE_MIN` exists so that deliveries and defrost cycles do not generate
false alarms. It is deliberately bypassed when a reading goes beyond a unit's
`tolerance_c`: an excursion that large is an alarm immediately, regardless of
duration.

## Status levels

| Status | Meaning |
| --- | --- |
| **OK** | Within critical limits with margin to spare. |
| **Warning** | Close to a limit, or outside it for less than `ALARM_GRACE_MIN`. |
| **Alarm** | Outside limits beyond the grace period, or beyond `tolerance_c` at any duration. |
| **No contact** | No reading for `STALE_AFTER_MIN` minutes. |

A silent sensor is treated as a fault rather than as good news — it is the most
dangerous failure mode, since everything looks calm while nothing is measured.

## Regulatory basis

The critical limits in the demo data and the references shown per unit come from:

- **Reg. (EC) 852/2004** — food hygiene; HACCP-based procedures, including the
  requirement to establish and document corrective actions (principle 5).
- **Reg. (EC) 853/2004, Annex III** — temperature limits for food of animal
  origin: fresh meat 7 °C, poultry 4 °C, minced meat 2 °C, fishery products at
  the temperature of melting ice.
- **Reg. (EC) 37/2005** — temperature monitoring for quick-frozen foods. From
  1 January 2006, measuring instruments must comply with **EN 12830** and
  **EN 13485**, with periodic verification to **EN 13486**. Records must be
  dated and kept for **at least one year**.
- **Directive 89/108/EEC** — quick-frozen foods at −18 °C, with brief upward
  fluctuations of no more than 3 °C permitted during transport and local
  distribution and in retail display cabinets.
- **Cyprus** — Food (Control and Sale) Law 54(I)/1996 and K.D.P. 320/2006. The
  competent authority is the Health Services (Υγειονομικές Υπηρεσίες) of the
  Ministry of Health.

### Two points worth confirming before selling this

**1. Records are held and presented, not filed.** No obligation to submit
temperature reports to the Cypriot state on a schedule was found. The duty is to
*maintain* records and produce them when Health Services inspect. The report in
this app is therefore built to be printed, signed and filed on site — not
transmitted. Confirm with the Health Services before promising a submission
feature.

**2. Retail display cabinets are exempt from the recorder requirement.** Under
Article 3 of Reg. (EC) 37/2005, air temperature in retail display cabinets and
during local distribution need only be measured by **at least one easily visible
thermometer**, and the competent authority may grant the same derogation for
cold rooms under 10 m³ in retail outlets. The recorder obligation bites on
warehousing and storage. This does not weaken the product case — a chain that
wants defensible HACCP records logs everything anyway — but it does mean the
sale is about evidence quality and labour saved, not about a legal obligation
the customer is currently breaching.

## Sensor procurement

Anything bought for the storage rooms should carry **EN 12830** conformity, and
the periodic verification records required by **EN 13486** need to be kept per
device — which is what the sensor register in the app is for. Loggers without
that conformity risk having their data rejected at inspection.

## Alarm delivery

Alarms escalate on a ladder and are re-sent until someone acts:

| Step | Default | Behaviour |
| --- | --- | --- |
| Level 1 | immediately | Recipients registered at level 1 (shift supervisors) |
| Level 2 | after 20 min | Recipients registered at level 2 (store management) |
| Repeat | every 30 min | Up to 3 times per level |
| Stop | — | Recording a corrective action ends the escalation for that deviation |

Recipients are managed in the app: name, role, channel (e-mail or SMS), address
and escalation level. Every attempt is written to a dispatch log that also
appears in the compliance report, so the alarm to notification to corrective
action chain can be shown as one record.

There are deliberately **no quiet hours**. A freezer failing at 03:00 is exactly
the alarm that matters, and silencing it would defeat the purpose.

A loss of contact escalates like a temperature alarm. It cannot be closed with a
corrective action, since there is no deviation to act on — it stops when the
sensor reports again, or after the repeat limit is reached.

### Where dispatch has to run

The page dispatches only while a browser has it open, which is not when a
compressor fails. **In production the escalation must run on the server.**
`backend/Code.gs` is a working Google Apps Script implementation that does this:

1. Create a spreadsheet with the sheets listed at the top of `Code.gs`
   (`Units`, `Readings`, `Recipients`, `Actions`, `Notifications`).
2. Extensions → Apps Script, paste `Code.gs`, fill in the constants.
3. Deploy as a web app and put the URL in `API_URL` in `index.html`.
4. Add a time-driven trigger running `checkAlarms` every 5 minutes.

E-mail goes out through `MailApp`. SMS posts JSON to whatever gateway is set in
`SMS_ENDPOINT`; left empty, SMS recipients are logged with status `skipped`
rather than silently dropped. Keep `LADDER_MIN`, `REPEAT_MIN` and `MAX_REPEATS`
in step with the matching constants in `index.html` so the app describes the
same rules the server enforces.

With that trigger in place the browser is only a viewer, and closing it changes
nothing.

## Not built yet

- Push notifications (e-mail and SMS are implemented)
- Multi-store hierarchy (currently a single site)
- Server-side storage of the full one-year history; the app reads whatever the
  endpoint returns and keeps corrective actions in the browser
- Authentication and per-user roles
- Signed or otherwise tamper-evident records
