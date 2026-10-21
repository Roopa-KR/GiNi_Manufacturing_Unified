# Admin first-run guide (Fresh Factory)

For the administrator who sets up an **empty** factory. Before this: `gini-fresh-setup.ps1` has run once and
`gini-3-start.ps1` is running (see `FRESH_FACTORY_SETUP.md`).

Open the admin app: **http://localhost:5174**

A dark-green banner at the top shows **“Fresh factory - team test”**, the factory name, the operating mode and the
plant date/time. If it says *Synthetic demonstration*, you are connected to the old demo database - stop and check
`backend/.env` (`GINI_ENVIRONMENT=FRESH_FACTORY`, `MONGODB_DB_NAME=gini_factory_teamtest`).

## 0. Sign in and change the bootstrap password

1. **Login ID**: the value of `ADMIN_LOGIN` (default `admin`). **Password**: the one you typed during `factory:init`
   (or `ADMIN_PASSWORD` from `backend/.env`).
2. If a yellow banner says *“Your initial administrator password must be changed”*: **Administration → My account** →
   enter the current and a new password (≥ 15 characters) → **Change**.
3. You land on **Overview**: every number is 0 and the blue banners say *No workers / No work centre / No tanks released*.
   That is correct - nothing exists yet.

## 1. The setup checklist

Left menu → **Fresh factory → Factory setup**. The **Checklist** tab shows ten steps, each **Not configured**,
**Partial** or **Ready**, with what is missing. Click a step to jump to its tab. At the top:

* **Configuration saved** - every area has data;
* **Ready to release** - factory, work centres, released products with checklists, skills and shifts are ready;
* **Ready to start** - also workers covering every required skill, an inspector, and stock for the bill of materials.

Work through the tabs in this order (the numbers are the tab names):

| Tab | What you enter | Rules the app checks |
|---|---|---|
| **1 · Factory** | Factory name, Site ID, Plant timezone (IANA name, e.g. `America/Bogota`, `Europe/Berlin`), Tank serial prefix (e.g. `TT`), Operating mode (`Manual team test`) | timezone must be valid; serial prefix letters/digits |
| **2 · Work centres** | per work centre: ID, Name, Area, Queue capacity; then **Add a station**: ID, Name, Work centre, Capacity | IDs unique; every work centre needs ≥ 1 station |
| **5 · Skills** | Skill ID, Name, Category (`PRODUCTION`, `INSPECTION`, …) | a route may only use defined skills |
| **6 · Shifts** | Shift code, Name, Start / End (plant time; overnight allowed), breaks, workdays | breaks inside the shift; generates the calendar 60 days ahead |
| **7 · Equipment & materials** | equipment (ID, type, station, initial availability); materials (ID, name, unit); **Receive stock** (material, quantity, lot) | stock starts at **0** - inventory is never unlimited; a duplicate lot is refused |
| **3 · Products & routes** | **New product**: Product ID, Name / model, Drawing / reference, Revision; route rows (Operation ID, Name, Kind, Work centre, Skill, Crew min/std/max, Labour minutes, Elapsed minutes, Gate, Milestones); bill of materials (Material, Quantity per tank, Consumed at operation) | an incomplete product is saved as **DRAFT** and the missing items are listed; release only when complete |
| **4 · Inspection checklists** | per gate: **Create &lt;gate&gt;** → questions (text, input type yes/no or reading, limits/unit for readings, the answer that fails) → **Save version** | a new version archives the old one; inspections already started keep the checklist they started with |

Then back on **3 · Products & routes** → **Release** on the product. A released product can be ordered.

> Optional shortcut: **Template import** loads an illustrative configuration (8 work centres, 3 products, checklists,
> shifts A/B). Every value is synthetic and labelled *illustrative · unconfirmed*. It never creates workers, orders or
> history. Type `IMPORT ILLUSTRATIVE TEMPLATE` to confirm. Afterwards you still have to **receive stock** and **create workers**.

## 2. Workers and logins (step 8)

**Administration → Workers → New worker**

1. First name, Last name, **Role** (`PRODUCTION_OPERATOR`, `QUALITY_INSPECTOR`, `AREA_SUPERVISOR`, `SHIFT_MANAGER`, `MATERIAL_HANDLER`, …), Home work centre,
   **Shift / calendar** (the shift templates you created), First shift: *Join the current shift* or *Start from the next
   shift* or *Future start date*.
2. **Qualifications**: pick each skill; untick *independent* for supervised-only.
3. **Login ID** (default = worker ID) and **Initial PIN** (6-8 digits). Leave *Require a PIN change* ticked for real people.
4. **Create worker and login** → the success screen shows the onboarding instructions to give the person
   (login ID, the operator app address, “signing in does not clock you in”). The PIN is not shown again and is stored only as a hash.

New workers have **zero history**, are **not clocked in** and are `HUMAN_ONLY`: no background agent ever acts for them.
You need at least one person per skill used by the route and one **quality inspector**.

## 3. First order and batch (steps 9-10)

1. **Orders & Batches → New work order**: Work-order / customer reference (optional, unique), Customer, Priority,
   **Product**, **Required GOOD tanks** (accepted good tanks - not attempts), **Due date / Due time** (plant time),
   **Production batches** (tanks per batch, comma separated, e.g. `2,2`) → **Create order**.
2. In the order line's batch table → **Release batch**. The app creates the tanks with unique identities
   (`TNK-FACTORY-00001`, serial `TT-26-00001`) and shows them. Releasing is refused while the product is a draft or
   has no route. Missing stock or equipment does not block the release, but it blocks **starting** the operation and is
   shown as a blocker on Dispatch.
3. **Fresh factory → Dispatch & assign**: each released tank shows its readiness (material, station, equipment, qualified
   people, crew size, checklist) and the blockers. **Assign crew** → tick the people → **Assign**.

From here the team works in the operator app - see `TEAM_TEST_WALKTHROUGH.md`.

## 4. What the admin sees afterwards

* **Overview**: measured counts only (accepted good, active WIP, scrapped, holds, people present/working).
* **Orders & Batches**: good / scrap / WIP per order, forecast band. With no history the forecast is
  **STANDARD-BASED** (labour standards, crew, shifts) and says so.
* **Quality**: holds, rework, returns. **Alerts**: rule evaluations (e-mail is captured, not sent, with `EMAIL_MODE=capture`).
* **Administration → Audit**: every configuration change and administrative action, with who/when/before/after.

## 5. Things the admin must not expect

* No clock controls (Play / Pause / Speed) in Manual team test: the clock is real time.
* Nothing moves by itself: tanks only progress when people act (except configured timed steps such as cure time or a transfer time).
* No reset button works unless `ALLOW_FACTORY_RESET=true` was set deliberately - see `DATA_RESET_POLICY.md`.
