import { useTranslation } from "react-i18next";
import { adminApi, type BlockedRange } from "../api";
import { Button, Field, Notice } from "../components";
import { ManagePage, useAdminResource, useDateFormat, Value } from "../manage";

/** Blocked addresses and ranges: their registrations, heartbeats, and events are refused. */
export function BlockedPage({ onSessionLost }: { onSessionLost: () => Promise<void> }) {
  const { t } = useTranslation();
  const formatDate = useDateFormat();
  const { data, error, busy, act } = useAdminResource<{ ranges: BlockedRange[] }>(
    "/blocked-ranges",
    onSessionLost,
  );
  return (
    <ManagePage heading={t("blocked.heading")} intro={t("blocked.intro")}>
      <section className="admin-card" aria-labelledby="block-heading">
        <h2 id="block-heading" className="card-heading">
          {t("blocked.add")}
        </h2>
        <form
          className="form form-split"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const fields = new FormData(form);
            void act(async () => {
              await adminApi.post("/blocked-ranges", {
                range: String(fields.get("range")).trim(),
                note: String(fields.get("note")).trim(),
              });
              form.reset();
            });
          }}
        >
          <Field
            label={t("blocked.range")}
            help={t("blocked.rangeHelp")}
            name="range"
            required
            maxLength={49}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
          />
          <Field label={t("blocked.note")} name="note" maxLength={100} autoComplete="off" />
          <Button busy={busy}>{t("blocked.add")}</Button>
        </form>
      </section>
      <Notice error={error} />
      {data !== undefined && data.ranges.length === 0 && (
        <p className="card-empty">{t("blocked.empty")}</p>
      )}
      {data !== undefined && data.ranges.length > 0 && (
        <ul className="row-list">
          {data.ranges.map((range) => (
            <li key={range.id} className="row-item">
              <div className="row-main">
                <p className="row-title">
                  <Value ltr>{range.range}</Value>
                </p>
                {range.note !== "" && (
                  <p className="row-note">
                    <Value>{range.note}</Value>
                  </p>
                )}
                <p className="field-help">
                  {t("blocked.added", {
                    date: formatDate(range.createdAt),
                    actor: range.createdBy,
                  })}
                </p>
              </div>
              <Button
                type="button"
                variant="quiet"
                busy={busy}
                onClick={() => void act(() => adminApi.post(`/blocked-ranges/${range.id}/delete`))}
              >
                {t("blocked.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </ManagePage>
  );
}
