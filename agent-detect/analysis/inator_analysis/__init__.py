"""Phase 6 analysis for the Anti-Anti-Detect-inator.

Reads the capture app's SQLite store (visits.db) and answers the test plan's
Phase 6 questions: how good is each signal, what weights should the scorer use,
which visits link back to one machine, and are the exit criteria met.
"""
__all__ = ["load", "grading", "fit", "population", "thresholds", "exit_criteria", "report"]
