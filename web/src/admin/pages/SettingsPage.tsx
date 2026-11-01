import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type AdminSettings, adminApi } from "../api";
import { Button, Field, Notice } from "../components";
import { ManagePage, useAdminResource, useDateFormat } from "../manage";

/** The heartbeat interval, the retention period, and the GeoLite2-ASN status. */
export function SettingsPage({ onSessionLost }: { onSessionLost: () => Promise<void> }) {
  const { t } = useTranslation();
  const formatDate = useDateFormat();
  const { data, error, busy, act } = useAdminResource<AdminSettings>("/settings", onSessionLost);
  const [saved, setSaved] = useState(false);
  const geoip = data?.geoip;

  let geoipText: string | undefined;
  if (geoip !== undefined) {
    if (geoip.state !== "ok" || geoip.buildDate === null) {
      geoipText = t("settings.geoipUnavailable");
    } else {
      const date = formatDate(geoip.buildDate);
      geoipText = geoip.stale
        ? t("settings.geoipStale", { date })
        : t("settings.geoipOk", { date });
    }
  }

  return (
    <ManagePage heading={t("settings.heading")} intro={t("settings.intro")}>
      {data !== undefined && (
        <section className="admin-card">
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              setSaved(false);
              void act(() =>
                adminApi.post("/settings", {
                  heartbeatIntervalSeconds: Number(fields.get("heartbeatIntervalSeconds")),
                  retentionDays: Number(fields.get("retentionDays")),
                }),
              ).then(setSaved);
            }}
          >
            <Field
              label={t("settings.interval")}
              help={t("settings.intervalHelp")}
              name="heartbeatIntervalSeconds"
              type="number"
              inputMode="numeric"
              min={30}
              max={600}
              step={1}
              required
              defaultValue={data.heartbeatIntervalSeconds}
            />
            <Field
              label={t("settings.retention")}
              help={t("settings.retentionHelp")}
              name="retentionDays"
              type="number"
              inputMode="numeric"
              min={8}
              max={3650}
              step={1}
              required
              defaultValue={data.retentionDays}
            />
            <Notice error={error}>{saved ? t("settings.saved") : undefined}</Notice>
            <Button busy={busy}>{t("settings.save")}</Button>
          </form>
        </section>
      )}
      {data === undefined && <Notice error={error} />}
      {geoipText !== undefined && (
        <section className="admin-card" aria-labelledby="geoip-heading">
          <h2 id="geoip-heading" className="card-heading">
            {t("settings.geoip")}
          </h2>
          <p
            className={geoip?.stale || geoip?.state !== "ok" ? "notice notice-error" : "card-intro"}
          >
            {geoipText}
          </p>
        </section>
      )}
    </ManagePage>
  );
}
