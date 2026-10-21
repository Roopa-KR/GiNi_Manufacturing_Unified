# Team test walkthrough (exact clicks)

A first team test from an **empty** fresh factory to one accepted good tank, then a failed inspection with rework.
Sections A-F were driven click by click through the real screens in an automated browser run (see
`TEST_RESULTS_FRESH_FACTORY.md`, “UI walkthrough”); section G (fail → hold → disposition → rework / scrap) was tested
through the same API commands the screens use, not clicked in a browser. The values are examples - use your own names.

* Admin app: **http://localhost:5174** (sign in as the bootstrap admin)
* Operator app: **http://localhost:5173** (workers; use a second browser, a private window or a phone on the same network)

## A. Admin: configure the factory (≈ 10 minutes)

Left menu **Fresh factory → Factory setup**.

1. Tab **1 · Factory** → *Factory name* `Team Test Plant`, *Site ID* `TT-01`, *Plant timezone* `America/Bogota`
   (your real zone), *Tank serial prefix* `TT`, *Operating mode* `Manual team test` → **Save factory settings**
   → green toast *“…saved”*.
2. Tab **2 · Work centres** → card *Add a work centre*: *ID* `FAB`, *Name* `Fabrication` → **Save work centre**.
   Card *Add a station*: *ID* `FAB-01`, *Name* `Bay 1`, *Work centre* `FAB` → **Save station**.
3. Tab **5 · Skills** → *Skill ID* `SK-WELD`, *Name* `Welding`, *Category* `PRODUCTION` → **Save skill**.
   Again: `SK-QC`, `Inspection`, `INSPECTION` → **Save skill**.
4. Tab **6 · Shifts** → *Shift code* `D`, *Name* `Day`, *Start (plant time)* `06:00`, *End (plant time)* `18:00`
   (or a range covering the time of your test), tick the workdays (include today) → **Save shift**.
5. Tab **7 · Equipment & materials** → material card: *Material ID* `MAT-KIT`, *Name* `Tank kit`, *Unit of measure* `KIT`
   → **Save material**. Then card *Receive stock*: *Material* `MAT-KIT`, *Quantity* `3` → **Record receipt**
   → toast *“Received …”*. (Stock starts at 0; without a receipt work cannot start.)
6. Tab **3 · Products & routes** → **New product**:
   * *Product ID* `TANK-T1`, *Name / model* `Test tank`, *Drawing / reference* `DWG-T1`;
   * route row 1: *Operation ID* `OP10`, *Name* `Weld`, *Work centre* `FAB`, *Skill* `SK-WELD`, *Labour minutes* `20`,
     *Elapsed minutes* `20`, *Gate* `QG10`;
   * **Add operation** → row 2: *Operation ID* `QG10`, *Name* `Gate`, *Kind* `INSPECTION`, *Work centre* `FAB`,
     *Skill* `SK-QC`, *Elapsed minutes* `5`;
   * bill of materials: *Material* `MAT-KIT`, *Consumed at operation* `OP10`;
   * **Save** → toast says **DRAFT** (the gate has no checklist yet - the missing item is listed).
7. Tab **4 · Inspection checklists** → **Create QG10** → *Question text* `Weld seams sound?` (yes/no) → **Save version**.
8. Tab **3 · Products & routes** → **Release** on `TANK-T1` → toast *“…released”*.
9. Tab **Checklist**: steps 1-7 show **Ready**; step 8 (workers) is next.

## B. Admin: create the people

**Administration → Workers → New worker** - once per person:

| First name | Role | Qualification | Login ID | Initial PIN |
|---|---|---|---|---|
| Olga | `PRODUCTION_OPERATOR` | `SK-WELD` | `olga` | a 6-8 digit PIN you tell her |
| Ivan | `QUALITY_INSPECTOR` | `SK-QC` | `ivan` | another PIN |

Fill *First name*, *Last name*, *Role*, *Home work centre* `FAB`, *Shift / calendar* `D`, *First shift* “Join the current
shift”, pick the qualification, *Login ID*, *Initial PIN* → **Create worker and login** → the success screen shows what to
tell the person → **Done**. (For a quick team test you may untick *Require a PIN change*; leave it ticked for real people.)

The **Checklist** tab now shows **Ready to start**.

## C. Admin: order, release, assign

1. **Orders & Batches → New work order**: *Work-order / customer reference* `PO-TT-1`, *Product* `TANK-T1`,
   *Required GOOD tanks* `1`, due date/time later today, *Production batches* `1` → **Create order** → **Done**.
2. In *Planned batches waiting for release* → **Release batch** → the dialog lists the new tank: `TNK-FACTORY-00001`, serial `TT-26-00001`
   → **Print tank labels** (a label with a Code 128 barcode per tank; stick it on the tank) → **Done**. Station labels:
   Factory setup → 2 · Work centres → **Label** next to each station. Any tank passport also has **Print label**.
3. **Fresh factory → Dispatch & assign** → the tank shows readiness (material in stock, station free, qualified people)
   → **Assign crew** → tick **Olga** → **Assign** → toast *“…assigned”*.

## D. Operator (Olga) - operator app

1. Sign in: *Login ID* `olga`, PIN. Signing in does **not** clock her in.
2. **Clock in**.
3. **Work** tab → the assigned operation on `TT-26-00001` → **Confirm tank** → scan the tank label (camera, or a handheld
   scanner into the field, or type the serial) → *“Correct tank”* (a wrong tank shows *“Wrong tank”*) → close →
   **Start work**. (Pause / Resume / Request help are available.) The **Scan** button at the top finds any tank or station;
   after scanning a tank it can also record where the tank is (scan the station label). Every scan is saved and listed in
   the tank passport under **Label scans**. If Factory setup → 1 · Factory → *Require a scan of the tank before people
   start work* is ticked, **Start work** stays locked until **Confirm tank** found the right tank.
4. If the operation has milestones, press **Done: &lt;milestone&gt;** for each.
5. **Finish work** → confirm. The tank now waits for inspection (finishing is not a pass).

## E. Inspector (Ivan) - operator app

0. Admin (optional but recommended): **Dispatch & assign** → on the tank waiting for inspection → **Assign inspector** →
   choose **Ivan** → **Assign inspector**. Only active, qualified inspectors who did not do the work are accepted.
1. Sign in as `ivan` → **Clock in**.
2. **Work** (or **Queue**) → **Inspect** on `TT-26-00001` (or **Scan & inspect** → scan the tank label, when *Require a scan
   of the tank before an inspection starts* is ticked) → the checklist opens with the version that was current when
   the inspection started.
3. Answer **Yes** → **Submit inspection** → the tank passes the last gate and is **accepted good**.

## F. Admin: check the result

* **Orders & Batches**: `PO-TT-1` shows *Good 1 / Required 1* → line complete.
* **Overview**: Accepted good 1, Active WIP 0.
* Click the serial → **Tank passport**: every event with who/when (plant time).
* **Workforce → Olga**: her labour segment and points; Ivan: inspection.
* **Administration → Audit**: every configuration step you made.

## G. Second round: failed inspection and rework

1. Admin: **Orders & Batches → New work order** (`PO-TT-2`, 1 tank) → **Release batch** → **Dispatch & assign** → Olga.
2. Olga: **Start work** → **Finish work**.
3. Ivan: **Inspect** → answer **No** → **Submit inspection** → the tank goes **on hold**.
4. Admin (or a quality supervisor): **Quality** → the hold → **Decide disposition** → *Repairable return* (or *Scrap*)
   → *Reason code* → **Confirm decision**.
   * *Repairable return*: the rework task appears for qualified people (Olga **Start work** / **Finish work**), then Ivan
     inspects again.
   * *Scrap*: the tank is permanently scrapped; good output is still 0 and the order still needs 1 accepted good tank.
     **Quality → Request replacement** on the scrapped tank → **Approve & release** → a replacement tank with a **new** identity is
     released for the same order line (the required quantity does not increase). Without material in stock the
     approval is shown as *Blocked* until stock is received.

## Rules to remember during the test

* Nobody is clocked in automatically and nothing finishes by itself: if Olga closes her browser while working, the task
  stays *working* until she (or a supervisor) finishes or pauses it.
* The clock is real time. There is no Play / Pause / Speed in Manual team test.
* Required quantity = accepted good tanks. Scrap and rework never count as good.
* Forecasts are **standard-based** until real history exists, and say so.
