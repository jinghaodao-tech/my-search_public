# ADR-009: Atomic candidate save

A candidate save creates a card and changes the candidate lifecycle. The article stores saved_card_id with a unique partial index. Card creation and the conditional lifecycle update run in one SQLite transaction, so a conflict rolls back both changes and returns candidate_save_conflict.
