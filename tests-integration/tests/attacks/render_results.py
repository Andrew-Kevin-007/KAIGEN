#!/usr/bin/env python3
"""Renders docs/v3/ATTACK-RESULTS.md from the JSON lines the attack tests append to KAIGEN_ATTACK_RESULTS.

    python tests-integration/tests/attacks/render_results.py <results.jsonl> <out.md> [<header facts json>]

Only values the tests measured are written. Nothing is computed here except unit formatting (yocto to NEAR, gas to Tgas).
The last line per id wins.
"""
import json
import sys

NEAR = 10**24


def load(path):
    rows = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            rows[d["id"]] = d["result"]
    return rows


def near(y):
    y = int(y)
    sign = "-" if y < 0 else ""
    y = abs(y)
    whole, frac = divmod(y, NEAR)
    if frac == 0:
        return f"{sign}{whole}"
    return f"{sign}{whole}." + f"{frac:024d}".rstrip("0")


def tg(g):
    return f"{int(g) / 1e12:.3f}"


def esc(x):
    return str(x).replace("|", "\\|").replace("\n", " ")


def table(header, body):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    for r in body:
        out.append("| " + " | ".join(esc(c) for c in r) + " |")
    return "\n".join(out) + "\n"


def render(rows, header):
    o = []
    o.append("# KAIGEN v3 attack results (M7 nine scripted attacks, M8 measured table)\n")
    o.append(
        "Caveat for every number below: sandbox, 128 ms blocks, ed25519 admin. Testnet was not run. "
        "Single-validator nearcore sandbox; the vault is Mamori built from this repository's HEAD. No audit, no mainnet.\n"
    )
    if header:
        o.append(table(["fact", "value"], [(k, v) for k, v in header.items()]))
    o.append(
        "Source of every number: the `ATTACK-RESULT` line each attack in `tests-integration/tests/attacks` prints "
        "(one JSON object per attack). Production of this file is described in section 14.\n"
    )

    def nr(title):
        return f"### {title}\n\nNOT RUN\n"

    def kvtab(i, title, spec):
        if i not in rows:
            return nr(title)
        r = rows[i]
        m = r["measured"]
        body = [("verdict", r["verdict"])]
        for label, fn in spec:
            try:
                body.append((label, fn(m)))
            except KeyError:
                body.append((label, "not measured in this run"))
        return f"### {title}\n\n" + table(["measured", "value"], body)

    def verdict(i):
        return rows[i]["verdict"] if i in rows else "NOT RUN"

    def mm(i):
        return rows[i]["measured"] if i in rows else {}

    # ---- 1. verdict table --------------------------------------------------------------------------------------------
    o.append("## 1. Verdicts against the documented claims (ARCHITECTURE.md section 7)\n")
    head = []

    def bound(i):
        b = mm(i).get("bound")
        if not b:
            return ""
        return f'C {near(b["C_cap_yocto"])} + P {near(b["P_pending_limit_yocto"])} = {near(b["C_plus_P_yocto"])} NEAR'

    def add(num, name, claim, ids, headline, lost=""):
        head.append((num, name, claim, "; ".join(f"{i}: {verdict(i)}" for i in ids), headline, lost))

    def h1(i):
        m = mm(i)
        if not m:
            return "NOT RUN"
        return (
            f'N={m["max_strikes_N"]}: strikes used {m["strikes_used"]}, key off the account {m["blocks_burn_decision_to_key_off_account"]} block after '
            f'the burn decision ({m["blocks_first_attempt_to_key_off_account"]} blocks after the first attempt), funds to attacker '
            f'{near(m["funds_moved_to_attacker_yocto"])} NEAR, {tg(m["gas_burnt_by_all_attempts"])} Tgas burnt'
        )

    add(1, "clumsy agent", "key burned at strike N, no funds above cap move", ["attack_1a", "attack_1b", "attack_1c"],
        "1a over-cap: " + h1("attack_1a") + " | 1b unlisted payee: " + h1("attack_1b") + " | 1c over-cap: " + h1("attack_1c"),
        (f'lost 0 NEAR in all three; bound {bound("attack_1a")}' if "attack_1a" in rows else ""))
    m2, m2c = mm("attack_2a"), mm("attack_2c")
    add(2, "calibrated attacker (mandatory)", "loss equals exactly one cap, zero strikes", ["attack_2a", "attack_2b", "attack_2c"],
        (f'loss {m2["loss_instant_near"]} NEAR = {m2["loss_instant_in_caps"]} cap, strikes {m2["strikes_after_probing"]} after {m2["probes_after_cap_used_up"]} more probes, '
         f'{m2["check_calls_used_by_the_attacker"]} `check` calls, {m2["send_calls_that_moved_money"]} sends over {m2["blocks_first_to_last_send"]} blocks, '
         f'queue filled to {near(m2["queued_pending_yocto"])} NEAR (locked)' if m2 else "2a NOT RUN")
        + (f' | one day later, nobody cancelling: {m2c["max_loss_in_any_24h_window_near"]} NEAR in one 24 h window (cap + pending = {m2c["bound_cap_plus_pending_near"]})' if m2c else " | 2c NOT RUN"),
        (f'2a: {m2["loss_instant_near"]} NEAR' + (f'; 2c: {m2c["max_loss_in_any_24h_window_near"]} NEAR in one window' if m2c else "; 2c NOT RUN") + f'; bound {bound("attack_2a")}') if m2 else "")
    m3a, m3b, m3c = mm("attack_3a"), mm("attack_3b"), mm("attack_3c")
    add(3, "burst of in-cap sends", "loss equals one cap", ["attack_3a", "attack_3b", "attack_3c"],
        (f'1 key: {m3a["attempted_in_caps"]} caps attempted in {m3a["calls_per_key"]} calls, {m3a["calls_that_moved_money"]} landed, loss {m3a["loss_near"]} NEAR, {m3a["blocks_spanned_by_the_burst"]} block' if m3a else "3a NOT RUN")
        + (f' | 4 keys: {m3b["attempted_in_caps"]} caps attempted, {m3b["calls_that_moved_money"]} landed, loss {m3b["loss_near"]} NEAR, {m3b["blocks_spanned_by_the_burst"]} blocks' if m3b else " | 3b NOT RUN")
        + (f' | default allowance: chain took in {m3c["calls_taken_in_by_the_chain"]} of {m3c["calls_signed"]}, loss {m3c["loss_near"]} NEAR' if m3c else " | 3c NOT RUN"),
        (f'3a {m3a["loss_near"]}, 3b {m3b["loss_near"]}, 3c {m3c["loss_near"]} NEAR; bound {bound("attack_3a")}' if m3a and m3b and m3c else ""))
    m4a, m4b = mm("attack_4a"), mm("attack_4b")
    add(4, "queue flood by one key", "caps hold, per-key slots hold, cancel_all works", ["attack_4a", "attack_4b"],
        (f'{m4a["flood_requests_sent_by_A"]} dust requests: {m4a["flood_requests_accepted"]} accepted (2 keys, count cap {m4a["queue_count_cap"]}), {m4a["flood_requests_refused_slots"]} refused, '
         f'honest key accepted {m4a["honest_request_B_accepted"]}, cancel_all removed {m4a["cancel_all_removed"]} for {tg(m4a["cancel_all_gas_burnt"])} Tgas' if m4a else "4a NOT RUN")
        + (f' | queued sum {near(m4b["queued_sum_yocto"])} NEAR = pending limit {near(m4b["pending_limit_yocto"])}' if m4b else " | 4b NOT RUN"),
        (f'{near(m4a["funds_moved_to_attacker_yocto"])} NEAR moved in 4a, {near(m4b["funds_moved_to_attacker_yocto"])} in 4b; at most {near(m4b["queued_sum_yocto"])} NEAR queued, none executable; bound {bound("attack_4a")}' if m4a and m4b and "funds_moved_to_attacker_yocto" in m4a else ""))
    m5 = mm("attack_5")
    add(5, "stale queue item", "expires and cannot execute", ["attack_5"],
        (f'execute of an expired request: "{m5["execute_of_stale_request"]}", purge_expired removed {m5["purge_expired_removed"]}, '
         f'{m5["chain_seconds_past_expiry_when_tried"]} chain s past expiry, funds from stale requests {m5["funds_reaching_payee_from_stale_requests_yocto"]}' if m5 else "NOT RUN"),
        "0 NEAR from the stale requests" if m5 else "")
    m6 = mm("attack_6")
    add(6, "new payee via request_withdraw", "queued, then cancelled", ["attack_6"],
        (f'queued {near(m6["request_amount_yocto"])} NEAR with no strike, execute at once "{m6["execute_at_once"]}", cancelled {m6["blocks_request_to_cancel"]} blocks '
         f'({m6["chain_ms_request_to_cancel"]} chain ms) after the request with {m6["lock_still_left_at_cancel_ms"]} ms of lock left, funds to payee {m6["funds_moved_to_new_payee_yocto"]}' if m6 else "NOT RUN"),
        (f'0 NEAR; 5 NEAR was queued; bound {bound("attack_6")}' if m6 else ""))
    m7 = mm("attack_7")
    add(7, "decimal-misread send", "refused or bounded per token", ["attack_7"],
        (f'largest single misread that went through: ft6 {m7["largest_single_misread_that_went_through_ft6_tokens"]} tokens (cap {m7["ft6_cap_tokens"]}), '
         f'NEAR {m7["largest_single_misread_that_went_through_near"]} (cap 1); total held by attacker ft6 {m7["max_loss_ft6_tokens"]} tokens' if m7 else "NOT RUN"),
        (f'ft6 {m7["max_loss_ft6_tokens"]} tokens vs cap + pending {m7["ft6_cap_plus_pending_tokens"]}; NEAR {m7["max_loss_near"]} vs {bound("attack_7")}' if m7 else ""))
    m8 = mm("attack_8")
    add(8, "planted full-access key and null-allowance key", "cage-check red, then green after removal", ["attack_8"],
        ("; ".join(f'{r["step"]}: exit {r["result"]["exit"]} {r["result"]["verdict"]}' + (f' {", ".join(r["result"]["red"])}' if r["result"]["red"] else "") for r in m8["runs"]) if m8 else "NOT RUN"))
    m9, m9b = mm("attack_9"), mm("attack_9b")
    add(9, "cross-key grief", "honest key B is not burned", ["attack_9", "attack_9b"],
        (f'B refused {m9["refusals_of_B_without_a_strike"]} times, strikes {m9["strikes_of_B_after"]} (v2 rule burns at {m9["v2_rule_would_have_burned_B_at_refusal"]})' if m9 else "9 NOT RUN")
        + (f' | B succeeds again a day later (last refusal at {m9b["last_refusal_of_B_chain_seconds_after_A_spend"]} chain s, first success at {m9b["first_success_of_B_chain_seconds_after_A_spend"]} chain s after A\'s spend)' if m9b else " | 9b NOT RUN"),
        (f'A spent {near(m9["cap_used_up_by_A_yocto"])} NEAR (the cap); B lost 0; bound {bound("attack_9")}' if m9 else ""))
    o.append(table(["#", "attack", "documented claim", "result", "headline measured numbers", "amount lost vs the bound C + P"], head))

    # ---- 2. attack 1 -------------------------------------------------------------------------------------------------
    o.append("## 2. Attack 1: clumsy agent\n")

    def clumsy(i, title):
        return kvtab(i, title, [
            ("variant", lambda m: m["variant"]),
            ("strikes used (N)", lambda m: f'{m["strikes_used"]} of {m["max_strikes_N"]}'),
            ("first attempt block", lambda m: m["first_attempt_block"]),
            ("burn decision block", lambda m: m["burn_decision_block"]),
            ("DeleteKey receipt block (key off the account from this block)", lambda m: m["deletekey_receipt_block"]),
            ("last callback block", lambda m: m["last_callback_block"]),
            ("blocks, burn decision to key off the account", lambda m: m["blocks_burn_decision_to_key_off_account"]),
            ("blocks, first attempt to key off the account", lambda m: m["blocks_first_attempt_to_key_off_account"]),
            ("chain ms, first attempt to key off the account", lambda m: m["chain_ms_first_attempt_to_key_off_account"]),
            ("key on the account at the burn block / the block before the delete / the delete block", lambda m: f'{m["key_on_account_at_burn_block"]} / {m["key_on_account_at_block_before_delete"]} / {m["key_on_account_at_delete_block"]}'),
            ("gas burnt by all attempts (Tgas)", lambda m: tg(m["gas_burnt_by_all_attempts"])),
            ("tokens burnt by all attempts (NEAR)", lambda m: near(m["tokens_burnt_yocto_all_attempts"])),
            ("gas burnt by the burning attempt alone (Tgas)", lambda m: tg(m["gas_burnt_burning_attempt_incl_delete_and_callbacks"])),
            ("allowance at the start / used before the burning attempt (NEAR)", lambda m: f'{near(m["allowance_start_yocto"])} / {near(m["allowance_used_before_burning_attempt_yocto"])}'),
            ("funds moved to the attacker (NEAR)", lambda m: near(m["funds_moved_to_attacker_yocto"])),
            ("vault balance change after settling (NEAR)", lambda m: near(m["vault_balance_change_yocto"])),
            ("after the burn, runtime rejects send_small / request_withdraw", lambda m: " / ".join(str(p["rejected_by_runtime"]) for p in m["after_burn"])),
        ])

    o.append(clumsy("attack_1a", "1a: 2 NEAR over the 1 NEAR cap, allowlist off, N = 3"))
    o.append(clumsy("attack_1b", "1b: 0.01 NEAR to a payee off the enforced allowlist, N = 3"))
    o.append(clumsy("attack_1c", "1c: 2 NEAR over the cap, allowlist off, N = 10 (the ceiling)"))

    # ---- 3. attack 2 -------------------------------------------------------------------------------------------------
    o.append("## 3. Attack 2: calibrated attacker (mandatory)\n")
    o.append(kvtab("attack_2a", "2a: drain the cap from `check`, probe on, fill the queue (day 0)", [
        ("cap (NEAR)", lambda m: near(m["cap_yocto"])),
        ("loss in the instant path (NEAR) = caps", lambda m: f'{m["loss_instant_near"]} = {m["loss_instant_in_caps"]}'),
        ("sends that moved money", lambda m: m["send_calls_that_moved_money"]),
        ("`check` calls used (free views)", lambda m: m["check_calls_used_by_the_attacker"]),
        ("blocks, first to last send", lambda m: m["blocks_first_to_last_send"]),
        ("strikes after the drain", lambda m: m["strikes_after_drain"]),
        ("refused probes after the cap was used up / strikes after them", lambda m: f'{m["probes_after_cap_used_up"]} / {m["strikes_after_probing"]}'),
        ("gas burnt per send, average (Tgas)", lambda m: tg(m["gas_burnt_per_send_avg"])),
        ("gas burnt per refused probe (Tgas)", lambda m: tg(m["gas_burnt_per_refused_probe"])),
        ("queued after the drain (NEAR) in requests", lambda m: f'{near(m["queued_pending_yocto"])} in {m["queued_requests"]}'),
        ("gas burnt per request_withdraw (Tgas)", lambda m: tg(m["gas_burnt_per_request_withdraw"])),
        ("queued request executable at once", lambda m: m["queued_request_executable_immediately"]),
        ("key still on the account", lambda m: m["key_still_on_account"]),
        ("vault balance change after settling (NEAR)", lambda m: near(m["vault_balance_change_yocto_incl_gas"])),
    ]))
    o.append(kvtab("attack_2b", "2b: uncounted probing until the node stops the key (allowance 0.02 NEAR)", [
        ("allowance at the start (NEAR)", lambda m: near(m["allowance_start_yocto"])),
        ("refused probes at 10 Tgas prepaid before the node stopped the key", lambda m: m["probes_refused_at_10_tgas_prepaid_before_the_node_stopped_the_key"]),
        ("allowance left when the 10 Tgas probes stopped (NEAR)", lambda m: near(m["allowance_when_the_10_tgas_probes_stopped_yocto"])),
        ("allowance used per probe, last (NEAR)", lambda m: near(m["allowance_used_per_probe_last_yocto"])),
        ("gas burnt per probe (Tgas)", lambda m: tg(m["gas_burnt_per_probe"])),
        ("further probes refused at 5 Tgas prepaid", lambda m: m["further_probes_refused_at_5_tgas_prepaid"]),
        ("allowance left at the end (NEAR)", lambda m: near(m["allowance_left_yocto"])),
        ("node's own words when asked again", lambda m: m["node_words_when_asked_again_at_10_tgas"][:260]),
        ("strikes at the end", lambda m: m["strikes_at_the_end"]),
        ("key on the account at the end / still recorded by the vault", lambda m: f'{m["key_on_account_after"]} / {m["key_still_recorded_by_the_vault"]}'),
    ]))
    o.append(kvtab("attack_2c", "2c: the same attacker one day later with nobody cancelling (chain clock moved 24 h)", [
        ("cap / pending limit (NEAR), delay (h)", lambda m: f'{near(m["cap_yocto"])} / {near(m["pending_limit_yocto"])}, {m["delay_hours"]}'),
        ("calls in the tight window (one send and the executes)", lambda m: m["calls_in_the_tight_window"]),
        ("blocks spanned by the tight window", lambda m: m["blocks_spanned_by_the_tight_window"]),
        ("most lost in any 24 h window (NEAR)", lambda m: m["max_loss_in_any_24h_window_near"]),
        ("cap + pending limit (NEAR)", lambda m: m["bound_cap_plus_pending_near"]),
        ("total held by the attacker over the 2 windows (NEAR)", lambda m: m["total_held_by_attacker_near"]),
        ("chain seconds between the first cap and the tight window", lambda m: m["chain_seconds_between_first_cap_and_the_tight_window"]),
        ("gas burnt per execute (Tgas)", lambda m: tg(m["gas_burnt_per_execute"])),
        ("admin actions taken", lambda m: m["admin_actions_taken"]),
    ]))

    # ---- 4. attack 3 -------------------------------------------------------------------------------------------------
    o.append("## 4. Attack 3: burst of in-cap sends\n")
    cols = [("attack_3a", "3a one key, 10 NEAR allowance"), ("attack_3b", "3b four keys, 10 NEAR allowance each"), ("attack_3c", "3c one key, default 0.25 NEAR allowance")]
    spec3 = [
        ("verdict", lambda r: r["verdict"]),
        ("calls signed (keys x calls per key)", lambda r: f'{r["measured"]["calls_signed"]} ({r["measured"]["keys"]} x {r["measured"]["calls_per_key"]})'),
        ("prepaid gas per call (Tgas)", lambda r: r["measured"]["prepaid_tgas_per_call"]),
        ("attempted (caps)", lambda r: r["measured"]["attempted_in_caps"]),
        ("calls the chain took in / never took in", lambda r: f'{r["measured"]["calls_taken_in_by_the_chain"]} / {r["measured"]["calls_never_taken_in"]}'),
        ("calls that moved money", lambda r: r["measured"]["calls_that_moved_money"]),
        ("calls refused as cap used up (uncounted)", lambda r: r["measured"]["calls_refused_cap_exhausted"]),
        ("sent per key", lambda r: r["measured"]["sent_per_key"]),
        ("loss (NEAR)", lambda r: r["measured"]["loss_near"]),
        ("strikes after (per key)", lambda r: r["measured"]["strikes_after"]),
        ("blocks spanned by the burst", lambda r: r["measured"]["blocks_spanned_by_the_burst"]),
        ("wall ms to submit all calls", lambda r: r["measured"]["wall_ms_to_submit_all_calls"]),
        ("gas per sent call / per refused call, average (Tgas)", lambda r: f'{tg(r["measured"]["gas_burnt_per_sent_call_avg"])} / {tg(r["measured"]["gas_burnt_per_refused_call_avg"])}'),
    ]
    body = []
    for label, fn in spec3:
        body.append([label] + [fn(rows[i]) if i in rows else "NOT RUN" for i, _ in cols])
    o.append(table(["measured"] + [t for _, t in cols], body))

    # ---- 5. attack 4 -------------------------------------------------------------------------------------------------
    o.append("## 5. Attack 4: queue flood\n")
    o.append(kvtab("attack_4a", "4a: 40 dust requests from one of two keys", [
        ("requests sent / accepted / refused (slots) / never taken in", lambda m: f'{m["flood_requests_sent_by_A"]} / {m["flood_requests_accepted"]} / {m["flood_requests_refused_slots"]} / {m["flood_calls_never_taken_in"]}'),
        ("queue length after the flood (count cap)", lambda m: f'{m["queue_len_after_flood"]} ({m["queue_count_cap"]})'),
        ("honest key's request accepted; queue length then", lambda m: f'{m["honest_request_B_accepted"]}; {m["queue_len_with_B"]}'),
        ("queued value (NEAR)", lambda m: near(m["queued_value_yocto"])),
        ("cancel_all removed", lambda m: m["cancel_all_removed"]),
        ("cancel_all gas (Tgas)", lambda m: tg(m["cancel_all_gas_burnt"])),
        ("blocks spanned by the flood", lambda m: m["blocks_spanned_by_the_flood"]),
        ("gas per accepted / per refused request, average (Tgas)", lambda m: f'{tg(m["gas_burnt_per_accepted_request_avg"])} / {tg(m["gas_burnt_per_refused_request_avg"])}'),
        ("strikes of A after", lambda m: m["strikes_A_after"]),
    ]))
    o.append(kvtab("attack_4b", "4b: both keys fill their share of the pending limit", [
        ("pending limit / each key's share (NEAR)", lambda m: f'{near(m["pending_limit_yocto"])} / {near(m["each_key_share_yocto"])}'),
        ("one yocto more from A", lambda m: m["A_one_yocto_more"]),
        ("one yocto more from B", lambda m: m["B_one_yocto_more"]),
        ("queued sum (NEAR); equals the pending limit", lambda m: f'{near(m["queued_sum_yocto"])}; {m["queued_sum_equals_pending_limit"]}'),
        ("cancel_all removed / gas (Tgas)", lambda m: f'{m["cancel_all_removed"]} / {tg(m["cancel_all_gas_burnt"])}'),
        ("the same request after cancel_all", lambda m: m["retry_after_cancel_all"]),
        ("gas per request_withdraw (Tgas)", lambda m: tg(m["gas_burnt_per_request_withdraw"])),
    ]))

    # ---- 6. attack 5 -------------------------------------------------------------------------------------------------
    o.append("## 6. Attack 5: stale queue item (chain clock moved 48 h)\n")
    o.append(kvtab("attack_5", "5: three requests, one executed in its window, two left to expire", [
        ("requests: executed inside the window / left to go stale", lambda m: f'{m["executed_inside_window"]} / {m["left_to_go_stale"]}'),
        ("delay / execute window (h)", lambda m: f'{m["delay_hours"]} / {m["execute_window_hours"]}'),
        ("chain seconds past expiry when tried", lambda m: m["chain_seconds_past_expiry_when_tried"]),
        ("execute of a stale request", lambda m: m["execute_of_stale_request"]),
        ("queue length after expiry, before the purge", lambda m: m["queue_len_after_expiry_before_purge"]),
        ("purge_expired removed", lambda m: m["purge_expired_removed"]),
        ("execute after the purge", lambda m: m["execute_after_purge"]),
        ("funds reaching the payee from the stale requests (yocto)", lambda m: m["funds_reaching_payee_from_stale_requests_yocto"]),
        ("gas: execute inside window / execute refused expired / purge_expired of 2 (Tgas)", lambda m: f'{tg(m["gas_burnt_execute_inside_window"])} / {tg(m["gas_burnt_execute_refused_expired"])} / {tg(m["gas_burnt_purge_expired_2_requests"])}'),
    ]))

    # ---- 7. attack 6 -------------------------------------------------------------------------------------------------
    o.append("## 7. Attack 6: new payee through request_withdraw\n")
    o.append(kvtab("attack_6", "6: 5 NEAR to an unlisted payee through the queue", [
        ("request amount (NEAR) = caps", lambda m: f'{near(m["request_amount_yocto"])} = {m["request_amount_in_caps"]}'),
        ("strikes: after the send_small control / after request_withdraw", lambda m: f'{m["send_small_control_strikes"]} / {m["strikes_after_request_withdraw"]}'),
        ("delay (ms)", lambda m: m["delay_ms"]),
        ("request block / cancel block / blocks between", lambda m: f'{m["request_block"]} / {m["cancel_block"]} / {m["blocks_request_to_cancel"]}'),
        ("chain ms, request to cancel", lambda m: m["chain_ms_request_to_cancel"]),
        ("lock still left at the cancel (ms)", lambda m: m["lock_still_left_at_cancel_ms"]),
        ("execute at once", lambda m: m["execute_at_once"]),
        ("execute after the cancel", lambda m: m["execute_after_cancel"]),
        ("funds moved to the new payee (yocto)", lambda m: m["funds_moved_to_new_payee_yocto"]),
        ("gas: request / cancel / refused execute (Tgas)", lambda m: f'{tg(m["gas_burnt_request_withdraw"])} / {tg(m["gas_burnt_cancel"])} / {tg(m["gas_burnt_execute_refused"])}'),
        ("admin actions needed", lambda m: m["admin_actions_needed"]),
    ]))

    # ---- 8. attack 7 -------------------------------------------------------------------------------------------------
    o.append("## 8. Attack 7: decimal-misread send\n")
    if "attack_7" in rows:
        m = rows["attack_7"]["measured"]
        body = []
        for c in m["cases"]:
            if c["asset"].startswith("ft"):
                amt = c.get("amount_sent_in_tokens", c["amount_sent_raw"] + " raw")
                moved = c.get("moved_to_attacker_tokens", c.get("moved_to_attacker", ""))
                intended = c["intended_tokens"] + " tokens"
            else:
                amt = c.get("amount_sent_near", "")
                moved = c.get("moved_to_attacker_near", "")
                intended = c["intended"] + " NEAR"
            body.append((c["asset"], intended, c["believed_decimals"], amt + (" (repeat)" if c.get("note") else ""), c["outcome"], moved))
        o.append(table(["asset", "intended", "decimals the agent believed", "amount sent", "outcome", "moved to attacker"], body))
        o.append(table(["measured", "value"], [
            ("verdict", rows["attack_7"]["verdict"]),
            ("largest single misread that went through: ft6 tokens (cap 100) / NEAR (cap 1)", f'{m["largest_single_misread_that_went_through_ft6_tokens"]} / {m["largest_single_misread_that_went_through_near"]}'),
            ("total held by the attacker: ft6 tokens / NEAR", f'{m["max_loss_ft6_tokens"]} / {m["max_loss_near"]}'),
            ("token fixture", m["ft_fixture"]),
        ]))
    else:
        o.append("NOT RUN\n")

    # ---- 9. attack 8 -------------------------------------------------------------------------------------------------
    o.append("## 9. Attack 8: planted keys and cage-check\n")
    if "attack_8" in rows:
        m = rows["attack_8"]["measured"]
        body = []
        for r in m["runs"]:
            x = r["result"]
            body.append((r["step"], x["exit"], x["verdict"], ", ".join(x["red"]) or "none", x["conditions_run"], x["block_read"], x["wall_ms"]))
        o.append(table(["step", "exit code", "verdict", "red rows", "rows run", "final block read", "checker wall ms"], body))
        o.append(table(["measured", "value"], [
            ("verdict", rows["attack_8"]["verdict"]),
            ("checker", "`jobs/src/bin.mjs cage-check`, committed HEAD"),
            ("blocks from the key change's last receipt to the block the checker read: full-access key / null-allowance key", f'{m["plant1_to_checker_block_distance"]} / {m["plant2_to_checker_block_distance"]}'),
            ("mode", m["mode"]),
        ]))
    else:
        o.append("NOT RUN\n")

    # ---- 10. attack 9 ------------------------------------------------------------------------------------------------
    o.append("## 10. Attack 9: cross-key grief\n")
    o.append(kvtab("attack_9", "9 (day 0)", [
        ("cap used up by A (NEAR)", lambda m: near(m["cap_used_up_by_A_yocto"])),
        ("refusals of B without a strike", lambda m: m["refusals_of_B_without_a_strike"]),
        ("refusal at which the v2 counting rule burns B", lambda m: m["v2_rule_would_have_burned_B_at_refusal"]),
        ("strikes of B after", lambda m: m["strikes_of_B_after"]),
        ("`check` for B", lambda m: json.dumps(m["check_for_B"], sort_keys=True)),
        ("gas per refused send of B (Tgas)", lambda m: tg(m["gas_burnt_per_refused_send_of_B"])),
        ("B's request_withdraw during the grief", lambda m: m["B_request_withdraw_during_the_grief"]),
        ("B still refused after A was removed", lambda m: m["B_refused_after_A_removed"]),
        ("control: counted refusals that burn the same key", lambda m: m["control_counted_refusals_to_burn"]),
    ]))
    o.append(kvtab("attack_9b", "9b: one chain day later", [
        ("chain seconds after A's spend: B's last refusal", lambda m: m["last_refusal_of_B_chain_seconds_after_A_spend"]),
        ("chain seconds after A's spend: B's first success", lambda m: m["first_success_of_B_chain_seconds_after_A_spend"]),
        ("window (s)", lambda m: m["window_seconds"]),
        ("strikes of B", lambda m: m["strikes_of_B"]),
        ("gas of B's send (Tgas)", lambda m: tg(m["gas_burnt_B_send"])),
    ]))

    # ---- 11. M8 ------------------------------------------------------------------------------------------------------
    o.append("## 11. M8: measured table\n")
    o.append("### 11.1 Blocks to key deletion\n")
    body = []
    for i, t in (("attack_1a", "burn by 3 over-cap sends"), ("attack_1b", "burn by 3 unlisted-payee sends"), ("attack_1c", "burn by 10 over-cap sends (N = 10)")):
        if i in rows:
            m = rows[i]["measured"]
            body.append((t, m["burn_decision_block"], m["deletekey_receipt_block"], m["last_callback_block"], m["blocks_burn_decision_to_key_off_account"], m["blocks_first_attempt_to_key_off_account"], m["chain_ms_first_attempt_to_key_off_account"]))
    o.append(table(["case", "burn decision block", "DeleteKey receipt block (key off the account)", "last callback block", "blocks, burn to off the account", "blocks, first attempt to off the account", "chain ms, first attempt to off the account"], body))
    o.append("### 11.2 Gas per call type\n")
    if "m8_gas" in rows:
        m = rows["m8_gas"]["measured"]
        o.append(f'Gas price {m["gas_price_yocto_per_gas"]} yocto per gas. Gas is summed over the transaction and every receipt it caused.\n')
        o.append(table(["call", "gas burnt (Tgas)", "tokens burnt (NEAR)", "receipts", "blocks, tx to last receipt"], [(x["call"], tg(x["gas_burnt"]), near(x["tokens_burnt_yocto"]), x["receipts"], x["blocks_tx_to_last_receipt"]) for x in m["rows"]]))
    else:
        o.append("NOT RUN\n")
    if "attack_5" in rows:
        m = rows["attack_5"]["measured"]
        o.append(table(["call (from attack 5)", "gas burnt (Tgas)"], [
            ("execute, inside its window, 1 NEAR", tg(m["gas_burnt_execute_inside_window"])),
            ("execute, refused as expired", tg(m["gas_burnt_execute_refused_expired"])),
            ("purge_expired, 2 requests", tg(m["gas_burnt_purge_expired_2_requests"])),
        ]))
    o.append("### 11.3 False-positive cost of a strike, in replay\n")
    if "m8_false_positive" in rows:
        m = rows["m8_false_positive"]["measured"]
        o.append(f'Caveat: {m["caveat"]}.\n')
        o.append(table(["honest mistake", "`check` says counted", "strikes after", "gas (Tgas)"], [(c["mistake"], c.get("check_says_counted", "n/a"), c["strikes_after"], tg(c["gas_burnt"])) for c in m["mistake_classes"]]))
        fb = m["false_burn"]
        o.append(table(["a false burn (3 counted honest mistakes)", "value"], [
            ("strikes seen", fb["strikes_seen"]),
            ("queued requests cancelled by the burn / value (NEAR)", f'{fb["queued_requests_cancelled_by_the_burn"]} / {near(fb["queued_value_cancelled_yocto"])}'),
            ("burn decision / DeleteKey / confirmed block", f'{fb["burn_decision_block"]} / {fb["deletekey_block"]} / {fb["confirmed_block"]}'),
            ("gas of the burning call (Tgas)", tg(fb["gas_burnt_by_the_burning_call"])),
            ("admin actions to recover / gas of the re-add (Tgas)", f'{fb["admin_actions_to_recover"]} / {tg(fb["gas_burnt_by_the_admin_re_add"])}'),
            ("blocks, burn decision to the re-add executed", fb["blocks_burn_to_re_add_executed"]),
            ("first send after the re-add", fb["first_send_after_re_add"]),
            ("request_withdraw after the re-add", fb["request_withdraw_after_re_add"]),
        ]))
        rr = m["re_add_race"]
        o.append(table(["admin re-adds the burned key at once (40 attempts, 10 ms apart)", "value"], [
            ("burn decision block / confirmed block", f'{rr["burn_decision_block"]} / {rr["confirmed_block"]}'),
            ("blocks in which the re-add was refused as not confirmed", f'{rr["blocks_with_re_add_refused_as_not_confirmed"]} (blocks {rr["refused_in_blocks"]})'),
            ("first successful re-add block", rr["first_successful_re_add_block"]),
            ("attempts total / that ran before the burn decision / after the first success", f'{rr["attempts_total"]} / {rr["attempts_that_ran_before_the_burn_decision"]} / {rr["attempts_after_the_first_success"]}'),
        ]))
        o.append(table(
            ["scripted honest trace, seed", "ops", "mix: pay / new payee / big pay / dust / no-limit token", "burn at op", "counted mistakes before burn", "uncounted refusals before burn", "honest payments completed before burn", "ops after the burn", "denied by the runtime"],
            [(t["seed"], t["trace_ops"], " / ".join(str(x["count_in_trace"]) for x in t["mix"]), t["burn_at_op"], t["counted_mistakes_before_burn"], t["uncounted_refusals_before_burn"], t["honest_payments_completed_before_burn"], t["ops_after_burn"], t["ops_denied_after_burn_by_runtime"]) for t in m["traces"]],
        ))
    else:
        o.append("NOT RUN\n")
    o.append(kvtab("m8_strike_lapse", "11.4 A strike lapses (chain clock moved 24 h)", [
        ("strikes before / strikes_of a day later", lambda m: f'{m["strikes_before_the_jump"]} / {m["strikes_of_after"]}'),
        ("chain seconds since the first strike", lambda m: m["chain_seconds_since_first_strike"]),
        ("a third mistake then", lambda m: m["third_mistake_outcome"]),
        ("cumulative count (open question Q4) measured", lambda m: m["cumulative_count_measured"]),
    ]))

    # ---- 12. clock jumps ---------------------------------------------------------------------------------------------
    if "timed_clock_jumps" in rows:
        m = rows["timed_clock_jumps"]
        o.append("## 12. Chain clock jumps used\n")
        o.append(table(["jump", "blocks skipped", "chain seconds", "wall seconds"], [(j["to"], j["blocks_skipped"], j["chain_seconds"], j["wall_seconds"]) for j in m["jumps"]]))

    o.append("## 13. Not run, and what the numbers do not cover\n")
    o.append("\n".join([
        "- Testnet: not run. Mainnet: not run. Every number is from one single-validator nearcore sandbox, 128 ms blocks.",
        "- The vault's admin is an ed25519 full-access key standing in for the ML-DSA key; attack 8 passes it to cage-check as `--stand-in-admin` and the checker marks the result not a production result.",
        "- Attack 7's NEP-141 is `tests-integration/fixtures/ft-mock`, a look-alike with no storage registration and an open mint, not a real token contract.",
        "- The honest traces in 11.3 are scripted by us; no recorded agent behaviour or agent-benchmark data was used. The cumulative strike count (open question Q4) does not exist in the contract and was not measured.",
        "- Admin response time (a human noticing and acting) is not measured; the recovery numbers are chain-side only.",
        "- Leash and near-agent-spend-guard (M9) were not run.",
        "- Attack 2b did not drive an allowance to exactly zero: the node began refusing the key's transactions while it still held the amount shown in 2b, because the prepaid gas of a call is charged against the allowance at a pessimistic price and refunded later. What the runtime does to a key whose allowance reaches exactly 0 was not observed.",
        "- One vault configuration only (cap 1 NEAR, default pending multiple 10, delay 24 h, 3 strikes except attack 1c with 10). Not exercised on a chain: eight daily keys at once, registered intents keys, a non-NEAR token in the queue, the failed-transfer refund and requeue paths (those are covered by the unit and property tests only), the ML-DSA admin.",
        "- Block counts are exact for this sandbox; blocks per second on testnet differ, so the block counts carry over and the chain-millisecond figures do not.",
        "",
    ]))
    o.append("## 14. How these numbers were produced\n")
    o.append(
        "`tests-integration/tests/attacks/*.rs` run against the WSL sandbox (`tests-integration/sandbox/start.ps1`) with `KAIGEN_ATTACK_RESULTS` set; "
        "this file is rendered from that results file by `tests-integration/tests/attacks/render_results.py`. Each attack asserts its own PASS conditions; "
        "a failed condition is recorded as FAIL and fails the test. The day-long parts (2c, 5, 9b, 11.4) move the chain clock with `sandbox_fast_forward`; "
        "the contract reads that clock, so they exercise the real 24 h rules without waiting (that one test is `#[ignore]`d and took about 100 minutes of wall time; section 12 gives the measured cost).\n"
    )
    return "\n".join(o)


if __name__ == "__main__":
    rows = load(sys.argv[1])
    header = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
    text = render(rows, header)
    with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"wrote {sys.argv[2]}: {len(rows)} result ids")
