import { useState } from "react";
import { useTranslation } from "react-i18next";
import { adminApi, type Provider } from "../api";
import { Button, Field, Notice } from "../components";
import { ERROR_KEYS } from "../errors";
import { ManagePage, useAdminResource, Value } from "../manage";

/** "64500, 64501 64502" to numbers; undefined when something is not a whole number. */
export function parseAsns(text: string): number[] | undefined {
  const parts = text.split(/[\s,]+/).filter((part) => part !== "");
  if (!parts.every((part) => /^\d{1,10}$/.test(part))) {
    return undefined;
  }
  return parts.map(Number);
}

function ProviderForm({
  provider,
  busy,
  onSubmit,
  onCancel,
}: {
  provider?: Provider;
  busy: boolean;
  onSubmit: (input: { name: string; asns: number[] }, form: HTMLFormElement) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      className="form form-split"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const fields = new FormData(form);
        const asns = parseAsns(String(fields.get("asns")));
        setInvalid(asns === undefined);
        if (asns !== undefined) {
          void onSubmit({ name: String(fields.get("name")).trim(), asns }, form);
        }
      }}
    >
      <Field
        label={t("providers.name")}
        name="name"
        required
        maxLength={100}
        defaultValue={provider?.name ?? ""}
        autoComplete="off"
      />
      <Field
        label={t("providers.asns")}
        help={t("providers.asnsHelp")}
        name="asns"
        defaultValue={provider?.asns.join(", ") ?? ""}
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
      />
      <div className="button-row">
        <Button busy={busy}>
          {provider === undefined ? t("providers.add") : t("common.save")}
        </Button>
        {onCancel !== undefined && (
          <Button type="button" variant="quiet" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        )}
      </div>
      <Notice error={invalid ? ERROR_KEYS.asnsInvalid : undefined} />
    </form>
  );
}

function ProviderItem({
  provider,
  busy,
  act,
}: {
  provider: Provider;
  busy: boolean;
  act: (change: () => Promise<unknown>) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (editing) {
    return (
      <li className="row-item row-item-editing">
        <ProviderForm
          provider={provider}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            if (await act(() => adminApi.post(`/providers/${provider.id}`, input))) {
              setEditing(false);
            }
          }}
        />
      </li>
    );
  }
  return (
    <li className="row-item">
      <div className="row-main">
        <p className="row-title">
          <Value>{provider.name}</Value>
        </p>
        <p className="field-help">
          {provider.asns.length === 0 ? (
            t("providers.noAsns")
          ) : (
            <Value ltr>{provider.asns.map((asn) => `AS${asn}`).join(", ")}</Value>
          )}
        </p>
      </div>
      <div className="button-row">
        <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
          {t("common.edit")}
        </Button>
        {confirming ? (
          <Button
            type="button"
            variant="danger"
            busy={busy}
            onClick={() => void act(() => adminApi.post(`/providers/${provider.id}/delete`))}
          >
            {t("providers.deleteConfirm")}
          </Button>
        ) : (
          <Button type="button" variant="quiet" onClick={() => setConfirming(true)}>
            {t("providers.delete")}
          </Button>
        )}
      </div>
    </li>
  );
}

/** The provider table: names grouping ASNs. The repository ships it empty. */
export function ProvidersPage({ onSessionLost }: { onSessionLost: () => Promise<void> }) {
  const { t } = useTranslation();
  const { data, error, busy, act } = useAdminResource<{ providers: Provider[] }>(
    "/providers",
    onSessionLost,
  );
  return (
    <ManagePage heading={t("providers.heading")} intro={t("providers.intro")}>
      <section className="admin-card" aria-labelledby="provider-heading">
        <h2 id="provider-heading" className="card-heading">
          {t("providers.add")}
        </h2>
        <ProviderForm
          busy={busy}
          onSubmit={async (input, form) => {
            if (await act(() => adminApi.post("/providers", input))) {
              form.reset();
            }
          }}
        />
      </section>
      <Notice error={error} />
      {data !== undefined && data.providers.length === 0 && (
        <p className="card-empty">{t("providers.empty")}</p>
      )}
      {data !== undefined && data.providers.length > 0 && (
        <ul className="row-list">
          {data.providers.map((provider) => (
            <ProviderItem key={provider.id} provider={provider} busy={busy} act={act} />
          ))}
        </ul>
      )}
    </ManagePage>
  );
}
