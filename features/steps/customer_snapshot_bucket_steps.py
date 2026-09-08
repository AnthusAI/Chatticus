"""Behave steps for the customer organization snapshot bucket."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

from behave import given, then

from chatticus.customer_computers_template import load_customer_computers_template
from chatticus.customer_snapshot_bucket import customer_snapshot_bucket_name
from chatticus.host_snapshot_store import register_snapshot_store_for_bucket
from chatticus.snapshot.store import SnapshotObjectStore
from chatticus.snapshot.uri import snapshot_uri

REPO_ROOT = Path(__file__).resolve().parents[2]
CUSTOMER_ROLE_TEMPLATE_PATH = REPO_ROOT / "infra" / "customer-role.yml"


class NoSuchBucketSnapshotStore:
    """Stand-in S3 store whose bucket has not been created yet."""

    def __init__(self, bucket: str) -> None:
        self.bucket = bucket

    def put(self, snapshot_uri: str, pack: bytes, manifest: object) -> None:
        del snapshot_uri, pack, manifest
        raise _no_such_bucket_error(self.bucket)

    def get_pack(self, snapshot_uri: str) -> bytes:
        del snapshot_uri
        raise _no_such_bucket_error(self.bucket)

    def get_manifest(self, snapshot_uri: str) -> object:
        del snapshot_uri
        raise _no_such_bucket_error(self.bucket)


def _no_such_bucket_error(bucket: str) -> Exception:
    from botocore.exceptions import ClientError

    return ClientError(
        {
            "Error": {
                "Code": "NoSuchBucket",
                "Message": f"The specified bucket does not exist: {bucket}",
            }
        },
        "GetObject",
    )


def _load_customer_role_template(context: object) -> str:
    stored = getattr(context, "customer_role_template", None)
    if stored is None:
        stored = CUSTOMER_ROLE_TEMPLATE_PATH.read_text(encoding="utf-8")
        context.customer_role_template = stored
    return stored


def _task_role_policy_statements(
    template: dict[str, object],
) -> list[dict[str, object]]:
    resources = template.get("Resources", {})
    if not isinstance(resources, dict):
        return []
    for key, resource in resources.items():
        if not isinstance(resource, dict):
            continue
        if resource.get("Type") != "AWS::IAM::Policy":
            continue
        if "ComputerTaskRoleDefaultPolicy" not in key:
            continue
        properties = resource.get("Properties", {})
        if not isinstance(properties, dict):
            continue
        document = properties.get("PolicyDocument", {})
        if not isinstance(document, dict):
            continue
        raw_statements = document.get("Statement", [])
        if isinstance(raw_statements, dict):
            raw_statements = [raw_statements]
        if isinstance(raw_statements, list):
            return [
                statement for statement in raw_statements if isinstance(statement, dict)
            ]
    return []


def _flatten_actions(statement: dict[str, object]) -> set[str]:
    raw_actions = statement.get("Action", [])
    if isinstance(raw_actions, str):
        return {raw_actions}
    if isinstance(raw_actions, list):
        return {str(action) for action in raw_actions}
    return set()


def _resource_matches_snapshot_bucket(
    resource: object,
    bucket_name: str,
) -> bool:
    if isinstance(resource, str):
        return bucket_name in resource
    if isinstance(resource, dict):
        fn_sub = resource.get("Fn::Sub")
        if isinstance(fn_sub, str):
            return "${SnapshotBucketName}" in fn_sub or bucket_name in fn_sub
        if isinstance(fn_sub, list) and fn_sub:
            template = str(fn_sub[0])
            if "${SnapshotBucketName}" in template or bucket_name in template:
                return True
            if len(fn_sub) > 1 and isinstance(fn_sub[1], dict):
                bucket_ref = fn_sub[1].get("Bucket")
                if bucket_ref == {"Ref": "SnapshotBucketName"}:
                    return True
    return False


def _flatten_resources(statement: dict[str, object]) -> list[object]:
    raw_resources = statement.get("Resource", [])
    if isinstance(raw_resources, str):
        return [raw_resources]
    if isinstance(raw_resources, dict):
        return [raw_resources]
    if isinstance(raw_resources, list):
        return list(raw_resources)
    return []


@given("the published customer cross-account CloudFormation template")
def given_published_customer_role_template(context: object) -> None:
    _load_customer_role_template(context)


@given("the committed customer ChatticusComputers CloudFormation template")
def given_committed_customer_computers_template(context: object) -> None:
    context.customer_computers_template = load_customer_computers_template()


@given('organization snapshot bucket name "{bucket_name}"')
def given_organization_snapshot_bucket_name(context: object, bucket_name: str) -> None:
    context.expected_snapshot_bucket_name = bucket_name


@then("the template declares an organization snapshot bucket in the customer account")
def then_template_declares_snapshot_bucket(context: object) -> None:
    template = _load_customer_role_template(context)
    assert "OrganizationSnapshotBucket:" in template
    assert "Type: 'AWS::S3::Bucket'" in template or "Type: AWS::S3::Bucket" in template
    assert "BucketName: !Sub 'chatticus-snapshots-${OrganizationId}'" in template


@then("the bucket uses server-side encryption and blocks public access")
def then_bucket_has_encryption_and_bpa(context: object) -> None:
    template = _load_customer_role_template(context)
    assert "BucketEncryption:" in template
    assert "SSEAlgorithm: AES256" in template
    assert "PublicAccessBlockConfiguration:" in template
    assert "BlockPublicAcls: true" in template
    assert "RestrictPublicBuckets: true" in template


@then("the bucket has versioning enabled")
def then_bucket_has_versioning(context: object) -> None:
    template = _load_customer_role_template(context)
    assert "VersioningConfiguration:" in template
    assert "Status: Enabled" in template


@then("the bucket deletion policy is Retain")
def then_bucket_deletion_policy_retain(context: object) -> None:
    template = _load_customer_role_template(context)
    bucket_section = template.split("OrganizationSnapshotBucket:", 1)[1]
    assert "DeletionPolicy: Retain" in bucket_section.split("Outputs:", 1)[0]
    assert "UpdateReplacePolicy: Retain" in bucket_section.split("Outputs:", 1)[0]


@then("the template exports SnapshotBucketName")
def then_template_exports_snapshot_bucket_name(context: object) -> None:
    template = _load_customer_role_template(context)
    assert "SnapshotBucketName:" in template
    assert "!Ref OrganizationSnapshotBucket" in template


@then("the cross-account role policy does not grant s3:CreateBucket")
def then_cross_account_role_no_create_bucket(context: object) -> None:
    template = _load_customer_role_template(context)
    role_section = template.split("ChatticusCrossAccountRole:", 1)[1]
    assert "s3:CreateBucket" not in role_section


@then(
    "the cross-account role policy does not grant s3 on Anthus-managed snapshot buckets"
)
def then_cross_account_role_no_anthus_bucket(context: object) -> None:
    template = _load_customer_role_template(context)
    role_section = template.split("ChatticusCrossAccountRole:", 1)[1]
    assert "ChatticusSnapshots" not in role_section
    assert not re.search(r"s3:[A-Za-z*]+", role_section)


@then("the cross-account role policy does not grant s3:*")
def then_cross_account_role_no_s3_wildcard(context: object) -> None:
    template = _load_customer_role_template(context)
    role_section = template.split("ChatticusCrossAccountRole:", 1)[1]
    assert "s3:*" not in role_section


@then("the computer task role grants s3:GetObject and s3:PutObject on that bucket")
def then_task_role_grants_snapshot_read_write(context: object) -> None:
    template = getattr(context, "customer_computers_template", None)
    assert template is not None
    bucket_name = context.expected_snapshot_bucket_name  # type: ignore[attr-defined]
    statements = _task_role_policy_statements(template)
    matching = [
        statement
        for statement in statements
        if statement.get("Sid") == "SnapshotReadWrite"
        and {"s3:GetObject", "s3:PutObject"}.issubset(_flatten_actions(statement))
        and any(
            _resource_matches_snapshot_bucket(resource, bucket_name)
            for resource in _flatten_resources(statement)
        )
    ]
    assert (
        matching
    ), f"Expected Get/Put on snapshot bucket {bucket_name!r}, got {statements!r}"


@then("the computer task role does not grant s3:CreateBucket")
def then_task_role_no_create_bucket(context: object) -> None:
    template = getattr(context, "customer_computers_template", None)
    assert template is not None
    for statement in _task_role_policy_statements(template):
        if statement.get("Sid") != "SnapshotReadWrite":
            continue
        assert "s3:CreateBucket" not in _flatten_actions(statement)


@then("the computer task role does not grant s3:ListBucket")
def then_task_role_no_list_bucket(context: object) -> None:
    template = getattr(context, "customer_computers_template", None)
    assert template is not None
    for statement in _task_role_policy_statements(template):
        if statement.get("Sid") != "SnapshotReadWrite":
            continue
        assert "s3:ListBucket" not in _flatten_actions(statement)


@then(
    "the computer container environment includes CHATTICUS_SNAPSHOT_BUCKET from the "
    "snapshot bucket parameter"
)
def then_container_env_includes_snapshot_bucket_parameter(context: object) -> None:
    template = getattr(context, "customer_computers_template", None)
    assert template is not None
    resources = template.get("Resources", {})
    assert isinstance(resources, dict)
    task_defs = [
        resource
        for resource in resources.values()
        if isinstance(resource, dict)
        and resource.get("Type") == "AWS::ECS::TaskDefinition"
    ]
    assert len(task_defs) == 1
    properties = task_defs[0].get("Properties", {})
    assert isinstance(properties, dict)
    containers = properties.get("ContainerDefinitions", [])
    assert isinstance(containers, list) and containers
    environment = containers[0].get("Environment", [])
    assert isinstance(environment, list)
    snapshot_env = next(
        (
            entry
            for entry in environment
            if isinstance(entry, dict)
            and entry.get("Name") == "CHATTICUS_SNAPSHOT_BUCKET"
        ),
        None,
    )
    assert snapshot_env is not None
    assert snapshot_env.get("Value") == {"Ref": "SnapshotBucketName"}


@then("the container environment does not hardcode an Anthus snapshot bucket name")
def then_container_env_no_anthus_bucket(context: object) -> None:
    template = getattr(context, "customer_computers_template", None)
    assert template is not None
    body = json.dumps(template)
    assert "ChatticusSnapshots" not in body


@then("CreateStack parameters include SnapshotBucketName for the organization")
def then_create_stack_includes_snapshot_bucket_name(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    assert len(cloudformation.create_stack_calls) == 1
    parameters = cloudformation.create_stack_calls[0].get("Parameters") or []
    org = context.start_org  # type: ignore[attr-defined]
    expected = customer_snapshot_bucket_name(org.tenant_id)
    assert parameters == [
        {"ParameterKey": "TenantId", "ParameterValue": org.tenant_id},
        {"ParameterKey": "SnapshotBucketName", "ParameterValue": expected},
    ]


@given("a customer organization snapshot bucket bound to the host worker")
def given_customer_snapshot_bucket_bound(context: object) -> None:
    import boto3
    from moto import mock_aws

    from chatticus.snapshot.s3 import S3SnapshotStore

    bucket = customer_snapshot_bucket_name("anthus")
    if not getattr(context, "snapshot_tmpdir", None):
        context.snapshot_tmpdir = tempfile.mkdtemp(prefix="chatticus-customer-bucket-")
    context.computer_hosts = {}
    os.environ["CHATTICUS_SNAPSHOT_BUCKET"] = bucket
    os.environ.pop("CHATTICUS_SNAPSHOT_STORE_ROOT", None)
    context._moto = mock_aws()
    context._moto.start()
    client = boto3.client("s3", region_name="us-east-1")
    client.create_bucket(Bucket=bucket)
    store = S3SnapshotStore(bucket, client=client)
    register_snapshot_store_for_bucket(bucket, store)
    context.snapshot_store = store
    context.customer_snapshot_bucket = bucket  # type: ignore[attr-defined]


@given("CHATTICUS_SNAPSHOT_BUCKET names a bucket that does not exist yet")
def given_ghost_snapshot_bucket(context: object) -> None:
    from computer_host_disk_lifecycle_steps import _worker_plane

    bucket = customer_snapshot_bucket_name("anthus")
    if not getattr(context, "snapshot_tmpdir", None):
        context.snapshot_tmpdir = tempfile.mkdtemp(prefix="chatticus-ghost-bucket-")
    context.computer_hosts = {}
    os.environ["CHATTICUS_SNAPSHOT_BUCKET"] = bucket
    os.environ.pop("CHATTICUS_SNAPSHOT_STORE_ROOT", None)
    store: SnapshotObjectStore = NoSuchBucketSnapshotStore(bucket)
    register_snapshot_store_for_bucket(bucket, store)
    context.snapshot_store = store
    context.ghost_snapshot_bucket = bucket  # type: ignore[attr-defined]
    context.snapshot_metadata_route_calls = 0
    computer = context.plane.computer_for_organization("anthus")
    computer.snapshot_uri = snapshot_uri(
        "anthus",
        computer.computer_id,
        bucket=bucket,
    )
    computer.snapshot_checksum = "0" * 64
    computer.hydrate_required = True
    context.plane._messaging_store.put_computer(computer)
    plane = _worker_plane(context, "garage-mac-1")
    original_hydrated = plane.record_computer_hydrated
    original_publish = plane.publish_computer_snapshot

    def counting_hydrated(*args: object, **kwargs: object) -> None:
        context.snapshot_metadata_route_calls += 1
        return original_hydrated(*args, **kwargs)

    def counting_publish(*args: object, **kwargs: object) -> None:
        context.snapshot_metadata_route_calls += 1
        return original_publish(*args, **kwargs)

    plane.record_computer_hydrated = counting_hydrated  # type: ignore[method-assign]
    plane.publish_computer_snapshot = counting_publish  # type: ignore[method-assign]
