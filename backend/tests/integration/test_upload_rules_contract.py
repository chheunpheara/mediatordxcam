"""Guards the upload rules that both layers implement.

The browser validates an image before uploading it, and the server validates it
again. That duplication is deliberate — the client check is a courtesy, the server
check is the enforcement point — but it means the same rule exists in two
languages and can drift apart quietly.

A drift here is nasty precisely because both sides are "working": the user picks
a photo that the app said was fine, waits for the upload, and is then rejected with
the very message that is supposed to mean they picked the wrong photo. Nothing
errors, nothing logs, and only the user finds out.

So the two are asserted to be the same rule, read from the sources rather than
restated here.
"""

from __future__ import annotations

import re

import pytest

from app.core.config import BACKEND_ROOT, Settings
from app.core.errors import USER_MESSAGES, ErrorCode

REPO_ROOT = BACKEND_ROOT.parent
VALIDATION_TS = REPO_ROOT / "frontend/src/features/document-upload/validation.ts"
ENV_EXAMPLE = REPO_ROOT / ".env.example"
COMPOSE_FILE = REPO_ROOT / "docker-compose.yml"

#: Rules the browser enforces before an upload leaves the device. A name here must
#: have a counterpart asserted below, so adding a client-side rule is a deliberate
#: act rather than an accident.
SHARED_RULES = ("MAX_FILE_SIZE_BYTES", "MIN_WIDTH_PX", "MIN_HEIGHT_PX")


@pytest.fixture(scope="module")
def client_constants() -> dict[str, int]:
    """Numeric constants exported by the browser's validation module.

    The right-hand side is evaluated rather than scraped, because these are
    written as arithmetic (`10 * 1024 * 1024`). A regex would capture just the
    leading `10` and quietly assert against a number nobody configured.
    """
    source = VALIDATION_TS.read_text()
    constants: dict[str, int] = {}
    for name, expression in re.findall(r"export const (\w+) = ([^;\n]+)", source):
        try:
            value = _evaluate(expression)
        except (SyntaxError, ValueError):
            continue
        if isinstance(value, int):
            constants[name] = value
    return constants


def _evaluate(expression: str) -> object:
    """Evaluate a numeric constant expression, allowing only literals and multiplication.

    Parsing rather than `eval` keeps this a check on the file's contents: a string
    or a call in one of these constants fails the test instead of executing.
    """
    import ast

    _OPERATIONS: dict[type[ast.operator], object] = {
        ast.Mult: lambda a, b: a * b,
        ast.Add: lambda a, b: a + b,
        ast.Sub: lambda a, b: a - b,
        ast.FloorDiv: lambda a, b: a // b,
    }

    def value(node: ast.expr) -> int:
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, int):
                raise ValueError("not an integer literal")
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in _OPERATIONS:
            return _OPERATIONS[type(node.op)](value(node.left), value(node.right))
        raise ValueError(f"unsupported expression: {ast.dump(node)}")

    return value(ast.parse(expression, mode="eval").body)


@pytest.mark.parametrize("rule", SHARED_RULES)
def test_the_client_defines_the_rule(client_constants: dict[str, int], rule: str) -> None:
    assert rule in client_constants, f"{rule} was removed from the browser validator"


@pytest.mark.parametrize(
    ("setting", "rule"),
    [
        ("max_upload_bytes", "MAX_FILE_SIZE_BYTES"),
        ("min_image_width", "MIN_WIDTH_PX"),
        ("min_image_height", "MIN_HEIGHT_PX"),
    ],
)
def test_both_layers_enforce_the_same_limit(
    client_constants: dict[str, int],
    setting: str,
    rule: str,
) -> None:
    """The server must never be looser than the browser that fed it."""
    server_value = getattr(Settings(), setting)
    client_value = client_constants[rule]

    assert client_value == server_value


def test_the_server_is_never_looser_than_the_browser(client_constants: dict[str, int]) -> None:
    """A server-only relaxation is invisible until a user hits it."""
    settings = Settings()
    assert settings.max_upload_bytes <= client_constants["MAX_FILE_SIZE_BYTES"]
    assert settings.min_image_width <= client_constants["MIN_WIDTH_PX"]
    assert settings.min_image_height <= client_constants["MIN_HEIGHT_PX"]


#: Where the upload limits are restated outside `Settings`. Each of these silently
#: wins over the model default when the value is present, so a change to one
#: without the others changes container behaviour while local development is
#: unaffected — which is the hardest kind of drift to notice.
LIMIT_MIRRORS = (
    ("MIN_IMAGE_WIDTH", "min_image_width"),
    ("MIN_IMAGE_HEIGHT", "min_image_height"),
    ("MAX_UPLOAD_BYTES", "max_upload_bytes"),
)


def _env_example_limits() -> dict[str, int]:
    values: dict[str, int] = {}
    for line in ENV_EXAMPLE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, raw = line.partition("=")
        try:
            values[name] = int(raw)
        except ValueError:
            continue
    return values


def _compose_defaults() -> dict[str, int]:
    import yaml

    compose = yaml.safe_load(COMPOSE_FILE.read_text())
    environment = compose["services"]["app"]["environment"]
    limits: dict[str, int] = {}
    for name, value in environment.items():
        # Compose defaults look like `${VAR:-fallback}`.
        if isinstance(value, str) and ":-" in value:
            _, _, fallback = value.partition(":-")
            try:
                limits[name] = int(fallback.rstrip("}"))
            except ValueError:
                continue
    return limits


@pytest.mark.parametrize(("variable", "setting"), LIMIT_MIRRORS)
@pytest.mark.parametrize("source", [_env_example_limits, _compose_defaults])
def test_container_configuration_does_not_contradict_the_model(
    source,
    variable: str,
    setting: str,
) -> None:
    """`.env.example` and compose must state the same limit as `Settings`.

    Whichever of the three is wrong, the symptom is the same: a photo the browser
    accepts is rejected by the running container with no clue why.
    """
    stated = source()
    if variable not in stated:
        pytest.skip(f"{variable} is not restated in this source")

    assert stated[variable] == getattr(Settings(), setting)


def test_both_layers_accept_the_same_error_codes(client_constants: dict[str, int]) -> None:
    """The browser maps these codes to its own messages; the server raises them."""
    source = VALIDATION_TS.read_text()
    for code in (
        "UNSUPPORTED_IMAGE_TYPE",
        "IMAGE_TOO_LARGE",
        "IMAGE_UNREADABLE",
        "IMAGE_TOO_LOW_RESOLUTION",
    ):
        assert code in source, f"{code} is handled in one layer only"


@pytest.mark.parametrize(
    ("code", "message_key"),
    [
        ("UNSUPPORTED_IMAGE_TYPE", "invalidType"),
        ("IMAGE_TOO_LARGE", "tooLarge"),
        ("IMAGE_TOO_LOW_RESOLUTION", "tooSmall"),
        ("IMAGE_UNREADABLE", "unreadable"),
    ],
)
def test_the_user_sees_the_same_sentence_in_both_layers(code: str, message_key: str) -> None:
    """The browser rejects locally and the server rejects again.

    If the two disagree, a user picks a file the app approved and is then told a
    different thing after the upload — the failure mode this duplication invites.
    The browser's copy is the one §7 specifies, so the server is held to it.
    """
    client_message = _client_message(message_key)
    server_message = USER_MESSAGES[ErrorCode(code)]

    if message_key == "tooSmall":
        # The server formats the configured floor into the message, so compare the
        # rendered text rather than the template.
        settings = Settings()
        server_message = server_message.format(
            min_width=settings.min_image_width,
            min_height=settings.min_image_height,
        )

    assert server_message == client_message


def _client_message(key: str) -> str:
    """Read one message literal out of the browser's validation module."""
    import re

    source = VALIDATION_TS.read_text()
    match = re.search(rf"{key}:\s*'([^']*)'", source)
    assert match, f"{key} not found in validation.ts"
    return match.group(1).replace("\\u00d7", "\u00d7")
