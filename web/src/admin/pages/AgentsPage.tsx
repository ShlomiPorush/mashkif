import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type AgentSummary, adminApi, type Infrastructure, type TrustTier } from "../api";
import { Button, Field, Notice } from "../components";
import { ManagePage, useAdminResource, useDateFormat, Value } from "../manage";

const TIERS: TrustTier[] = ["trusted", "normal", "low", "suspicious", "blocked"];

const INFRA_KEYS = {
  unknown: "infra.unknown",
  bezeq: "infra.bezeq",
  hot: "infra.hot",
  ibc: "infra.ibc",
  partner_fiber: "infra.partnerFiber",
  cellcom_fiber: "infra.cellcomFiber",
  other: "infra.other",
} as const satisfies Record<Infrastructure, string>;

const EVENT_KEYS = {
  connectivity_lost: "eventKind.connectivityLost",
  connectivity_restored: "eventKind.connectivityRestored",
  shutdown: "eventKind.shutdown",
  sleep: "eventKind.sleep",
  resume: "eventKind.resume",
  service_stop: "eventKind.serviceStop",
} as const;

function eventKey(kind: string) {
  return EVENT_KEYS[kind as keyof typeof EVENT_KEYS] ?? "common.unknown";
}

function AgentEditor({
  agent,
  busy,
  onSave,
  onCancel,
}: {
  agent: AgentSummary;
  busy: boolean;
  onSave: (changes: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  // Whether the admin changed the tier in this edit. A refreshed agent (for
  // example promoted in the background) must never make an untouched select
  // send its stale value, which would demote the agent and restart its trial.
  const [tierChanged, setTierChanged] = useState(false);
  return (
    <form
      className="form agent-editor"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const cell = String(form.get("assignedCell")).trim().toLowerCase();
        void onSave({
          label: String(form.get("label")).trim(),
          ...(tierChanged ? { trustTier: String(form.get("trustTier")) } : {}),
          assignedCell: cell === "" ? null : cell,
        });
      }}
    >
      <Field
        label={t("agents.labelField")}
        name="label"
        defaultValue={agent.label ?? ""}
        maxLength={100}
        autoComplete="off"
      />
      <div className="field">
        <label className="field-label" htmlFor={`tier-${agent.id}`}>
          {t("agents.tierField")}
        </label>
        <select
          id={`tier-${agent.id}`}
          className="field-input"
          name="trustTier"
          defaultValue={agent.trustTier}
          onChange={() => setTierChanged(true)}
          aria-describedby={`tier-help-${agent.id}`}
        >
          {TIERS.map((tier) => (
            <option key={tier} value={tier}>
              {t(`tier.${tier}`)}
            </option>
          ))}
        </select>
        <p id={`tier-help-${agent.id}`} className="field-help">
          {t("agents.tierHelp")}
        </p>
      </div>
      <Field
        label={t("agents.areaField")}
        help={t("agents.areaHelp")}
        name="assignedCell"
        defaultValue={agent.assignedCell ?? ""}
        maxLength={15}
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
      />
      <div className="button-row">
        <Button busy={busy}>{t("common.save")}</Button>
        <Button type="button" variant="quiet" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

function AgentCard({
  agent,
  promotionDays,
  busy,
  act,
}: {
  agent: AgentSummary;
  promotionDays: number;
  busy: boolean;
  act: (change: () => Promise<unknown>) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const formatDate = useDateFormat();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const area = agent.assignedCell ?? agent.reportedCell;
  const revoked = agent.revokedAt !== null;

  return (
    <li className={revoked ? "agent-card agent-card-revoked" : "agent-card"}>
      <div className="agent-head">
        <h2 className="agent-name">
          {agent.label === null ? t("agents.unlabeled") : <Value>{agent.label}</Value>}
        </h2>
        <span className={`badge badge-${revoked ? "revoked" : agent.trustTier}`}>
          {revoked ? t("agents.revoked") : t(`tier.${agent.trustTier}`)}
        </span>
      </div>
      <dl className="facts">
        {!revoked && agent.trustTier === "low" && (
          <div>
            <dt>{t("agents.trial")}</dt>
            <dd>
              {t("agents.trialDays", { days: agent.activeDays, needed: promotionDays })}{" "}
              <span className="fact-note">{t("agents.trialRule")}</span>
            </dd>
          </div>
        )}
        <div>
          <dt>{t("agents.lastSeen")}</dt>
          <dd>
            {agent.lastSeenAt === null ? (
              t("agents.notSeen")
            ) : (
              <Value>{formatDate(agent.lastSeenAt)}</Value>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("agents.address")}</dt>
          <dd>
            {agent.address === null ? t("common.unknown") : <Value ltr>{agent.address}</Value>}
          </dd>
        </div>
        <div>
          <dt>{t("agents.network")}</dt>
          <dd>
            {agent.asn === null ? (
              t("common.unknown")
            ) : (
              <Value ltr>
                {t("agents.asn", { asn: agent.asn })}
                {agent.asOrganization === null ? "" : ` · ${agent.asOrganization}`}
              </Value>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("agents.provider")}</dt>
          <dd>
            {agent.providerName === null ? t("common.none") : <Value>{agent.providerName}</Value>}
          </dd>
        </div>
        <div>
          <dt>{t("agents.area")}</dt>
          <dd>
            {area === null ? (
              t("common.unknown")
            ) : (
              <>
                <Value ltr>{area}</Value>{" "}
                <span className="fact-note">
                  {agent.assignedCell === null
                    ? t("agents.areaReported")
                    : t("agents.areaAssigned")}
                </span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("agents.infrastructure")}</dt>
          <dd>{t(INFRA_KEYS[agent.infrastructure] ?? "common.unknown")}</dd>
        </div>
        <div>
          <dt>{t("agents.version")}</dt>
          <dd>
            <Value ltr>{agent.agentVersion}</Value>
          </dd>
        </div>
        <div>
          <dt>{t("agents.interval")}</dt>
          <dd>
            {agent.silenceIntervalSeconds === null
              ? t("common.unknown")
              : t("agents.seconds", { seconds: agent.silenceIntervalSeconds })}
          </dd>
        </div>
        <div>
          <dt>{t("agents.lastEvent")}</dt>
          <dd>
            {agent.lastEventKind === null || agent.lastEventAt === null ? (
              t("common.none")
            ) : (
              <>
                {t(eventKey(agent.lastEventKind))} <Value>{formatDate(agent.lastEventAt)}</Value>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("agents.registered")}</dt>
          <dd>
            <Value>{formatDate(agent.registeredAt)}</Value>
          </dd>
        </div>
        {Number(agent.droppedEvents) > 0 && (
          <div>
            <dt>{t("agents.dropped")}</dt>
            <dd>
              <Value>{String(agent.droppedEvents)}</Value>
            </dd>
          </div>
        )}
        {agent.revokedAt !== null && (
          <div>
            <dt>{t("agents.revoked")}</dt>
            <dd>
              <Value>{formatDate(agent.revokedAt)}</Value>
            </dd>
          </div>
        )}
      </dl>
      {!revoked && editing && (
        <AgentEditor
          agent={agent}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (changes) => {
            if (await act(() => adminApi.post(`/agents/${agent.id}`, changes))) {
              setEditing(false);
            }
          }}
        />
      )}
      {!revoked && !editing && (
        <div className="button-row">
          <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
            {t("common.edit")}
          </Button>
          {confirming ? (
            <>
              <Button
                type="button"
                variant="danger"
                busy={busy}
                onClick={() => void act(() => adminApi.post(`/agents/${agent.id}/revoke`))}
              >
                {t("agents.revokeConfirm")}
              </Button>
              <Button type="button" variant="quiet" onClick={() => setConfirming(false)}>
                {t("common.cancel")}
              </Button>
            </>
          ) : (
            <Button type="button" variant="quiet" onClick={() => setConfirming(true)}>
              {t("agents.revoke")}
            </Button>
          )}
        </div>
      )}
      {confirming && !revoked && <p className="field-help">{t("agents.revokeHelp")}</p>}
    </li>
  );
}

/** Registered agents with their latest heartbeat, and editing of label, tier, and area. */
export function AgentsPage({ onSessionLost }: { onSessionLost: () => Promise<void> }) {
  const { t } = useTranslation();
  const { data, error, busy, act } = useAdminResource<{
    agents: AgentSummary[];
    promotionDays: number;
  }>("/agents", onSessionLost);
  return (
    <ManagePage heading={t("agents.heading")} intro={t("agents.intro")}>
      <Notice error={error} />
      {data !== undefined && data.agents.length === 0 && (
        <p className="card-empty">{t("agents.empty")}</p>
      )}
      {data !== undefined && data.agents.length > 0 && (
        <ul className="agent-list">
          {data.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              promotionDays={data.promotionDays}
              busy={busy}
              act={act}
            />
          ))}
        </ul>
      )}
    </ManagePage>
  );
}
