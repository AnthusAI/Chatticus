"use client";

import { useState } from "react";

import {
  AuthCard,
  authButtonClassName,
  authErrorClassName,
  authFieldClassName,
  authStatusClassName,
} from "./AuthCard";
import { CUSTOMER_ROLE_TEMPLATE_PATH, submitSelfSetupCrossAccountRole } from "../lib/self-setup-cross-account-role";
import { CROSS_ACCOUNT_SELF_SETUP_FORM_TITLE } from "../lib/membership-view";
import { useMembership } from "../lib/membership-context";
import type { MeOrganization } from "../lib/me";

type SelfSetupCrossAccountRolePanelProps = {
  organization: MeOrganization;
};

export function SelfSetupCrossAccountRolePanel({
  organization,
}: SelfSetupCrossAccountRolePanelProps) {
  const { refreshMe } = useMembership();
  const [accountId, setAccountId] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <AuthCard title={CROSS_ACCOUNT_SELF_SETUP_FORM_TITLE}>
      <p className={authStatusClassName}>
        Use your organization id{" "}
        <span className="font-mono">{organization.tenant_id}</span> as the
        CloudFormation <span className="font-mono">OrganizationId</span>{" "}
        parameter. Download the template from{" "}
        <a className="underline" href={CUSTOMER_ROLE_TEMPLATE_PATH}>
          {CUSTOMER_ROLE_TEMPLATE_PATH}
        </a>
        .
      </p>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedAccountId = accountId.trim();
          const trimmedRoleArn = roleArn.trim();
          if (!trimmedAccountId || !trimmedRoleArn || submitting) {
            return;
          }
          setSubmitting(true);
          setError(null);
          void submitSelfSetupCrossAccountRole(organization.tenant_id, {
            account_id: trimmedAccountId,
            cross_account_role: trimmedRoleArn,
          })
            .then(() => refreshMe())
            .catch((caught) => {
              setError(caught instanceof Error ? caught.message : "submit failed");
            })
            .finally(() => {
              setSubmitting(false);
            });
        }}
      >
        <label className="sr-only" htmlFor="aws-account-id">
          AWS account id
        </label>
        <input
          id="aws-account-id"
          className={authFieldClassName}
          placeholder="AWS account id"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
          disabled={submitting}
        />
        <label className="sr-only" htmlFor="cross-account-role-arn">
          RoleArn
        </label>
        <input
          id="cross-account-role-arn"
          className={authFieldClassName}
          placeholder="RoleArn from CloudFormation output"
          value={roleArn}
          onChange={(event) => setRoleArn(event.target.value)}
          disabled={submitting}
        />
        {error ? <p className={authErrorClassName}>{error}</p> : null}
        <button
          type="submit"
          className={authButtonClassName}
          disabled={submitting || !accountId.trim() || !roleArn.trim()}
        >
          Submit AWS setup
        </button>
      </form>
    </AuthCard>
  );
}
