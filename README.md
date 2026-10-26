# Homebridge Sinopé

Maintained fork: https://github.com/alexey-temnikov/homebridge-sinope

Supports Neviweb thermostats (`TH`/`OTH`), switches/load controllers (`SW`/`RM`), outlets (`SP`), and dimmers (`DM`). Requires Node 22, 24 or 26 and Homebridge 1.8 or later. Tested with Homebridge 2.4.0/HAP 2.2.2.

## Installation from this fork

```sh
npm ci --ignore-scripts
npm run check
npm pack
# In the Homebridge storage directory, using the same Node as Homebridge:
npm install /absolute/path/to/wfortin-homebridge-sinope-1.0.5.tgz --omit=dev --ignore-scripts
```

The package deliberately retains `@wfortin/homebridge-sinope` and platform alias `Sinope` so existing deployed accessories keep their ownership. This is a source fork, not a new release on the upstream npm account. Do not install a second copy alongside the existing plugin. Back up Homebridge configuration, pairing records, accessory cache, and the existing plugin before installation. Build artifacts are included in the tarball; installing an unbuilt Git checkout does not compile it automatically.

Existing device UUIDs still derive from the Neviweb identifier. Cached accessories are retained during cloud outages. No re-pairing is required when replacing the existing scoped package.

## Configuration

```json
{
  "platform": "Sinope",
  "username": "your-Neviweb-email",
  "password": "your-Neviweb-password",
  "url": "https://neviweb.com/api",
  "requestTimeoutMs": 3500,
  "pollInterval": 60
}
```

`locationid` is an optional location filter. API URLs require HTTPS; HTTP is permitted only for loopback test servers. Never include credentials in the URL. The HomeKit temperature display preference is separate from the physical thermostat's display, and API temperatures remain Celsius. TH1123/TH1124 setpoints support 5–30 °C, in 0.5 °C steps ([manufacturer specification](https://support.sinopetech.com/en/wp-content/uploads/sites/4/2019/08/Product-Fact-Sheet-TH1123ZB-TH1124ZB-270-1505-0001-D.pdf)).

## Reliability changes in 1.0.5

- Concurrent reads share one in-flight fetch per device. Removed `async-lock` waiters and uncaught async callbacks that could stop the entire bridge.
- Bounded HTTP requests cover both headers and body. Authentication is shared, refresh uses local receipt time, and login failures have backoff.
- Cloud failures become HomeKit communication errors, not fabricated zero temperatures or successful writes. Partial/malformed telemetry is rejected.
- Device writes are serialized with bounded queues and expired queued commands are canceled. Ambiguous failed commands are never replayed, including dimmer brightness writes.
- Fixes Zigbee thermostat mode reads/writes to use `systemMode` (`heat`/`off`); Wi-Fi models retain `setpointMode` (`manual`/`auto`/`off`). Zigbee models expose only Off/Heat in HomeKit.
- Preserves deployed thermostat, relay, outlet and dimmer support. Reuses cached services; fixes the switch On characteristic and supports structured heating-output telemetry. OutletInUse reports unavailable because relay state alone does not prove a physical load is drawing current.
- Handles discovery failure without dropping cached devices; retries safely. Timers are cleaned on shutdown. Credentials, session tokens and raw transport errors are never logged.
- Zero production npm dependencies. Uses the supported Node runtime HTTP client.

## Validation

```sh
npm ci --ignore-scripts
npm run check
npm audit --omit=dev
```

The strict rejection test suite uses real HAP characteristic handlers and loopback HTTP servers to test concurrent reads, unavailable API responses, hung headers/bodies, session renewal, failed writes, queue expiry, malformed data, restart/discovery behavior, and identity preservation. Tests use synthetic devices; they do not change real thermostats or relays. Live read-only checks should confirm current telemetry and identities after deployment. These software fixes do not correct an inadequate power supply.
