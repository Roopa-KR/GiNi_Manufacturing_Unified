"""GiNi manufacturing calculation and simulation engine (synthetic demonstration; not a Siemens system).

Ownership (prevents two competing formula implementations):
  * Python owns derived manufacturing calculations: state reduction from history, plant agents' decisions, labour
    accounting, points ledger, variance rules and alert lifecycle, forecasts, cutoff bands, recovery simulation,
    verification, projections.
  * Express owns operational authorization and command transitions. Plant agents issue their decisions through the
    protected Express internal command endpoint, so background operators use the same validated transitions as humans.
"""
ENGINE_VERSION = "1.0.0"
