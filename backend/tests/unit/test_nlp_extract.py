"""The NLP prompt must teach the model what keyword scanning cannot (D24).

Which token of the card's single Name run is the family name is a question of
the card's style, not of labels — so the prompt carries that style, and the
output contract stays exactly the nine field keys the rest of the pipeline
reads.
"""

from __future__ import annotations

from app.services.nlp_extract import _FIELD_KEYS, _prompt


def test_the_prompt_teaches_the_cards_name_order() -> None:
    prompt = _prompt("SAMPLE TEXT")

    assert "GIVEN NAME first" in prompt
    assert "FAMILY NAME last" in prompt
    assert "digits or Latin letters is OCR noise" in prompt
    assert "firstNameKhmer" in prompt and "lastNameKhmer" in prompt


def test_the_prompt_carries_the_contract_and_the_text() -> None:
    prompt = _prompt("SAMPLE TEXT")

    for key in _FIELD_KEYS:
        assert key in prompt
    assert prompt.endswith("TEXT:\nSAMPLE TEXT")
