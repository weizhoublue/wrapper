# GitHub Actions Node 24 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade all GitHub Actions in workflow files to their latest major versions supporting the Node.js 24 runtime to resolve deprecation warnings.

**Architecture:** Modify version tags of the actions in `.github/workflows/build.yml`, `.github/workflows/pr.yml`, and `.github/workflows/release.yml`. Use Ruby's built-in YAML parser to validate the syntax of modified files.

**Tech Stack:** GitHub Actions, Ruby (for YAML syntax validation)

## Global Constraints
- Target version mappings:
  - `actions/checkout@v4` -> `actions/checkout@v7`
  - `actions/setup-node@v4` -> `actions/setup-node@v6`
  - `actions/cache@v4` -> `actions/cache@v6`
  - `actions/upload-artifact@v4` -> `actions/upload-artifact@v6`
  - `actions/download-artifact@v4` -> `actions/download-artifact@v6`
  - `softprops/action-gh-release@v2` -> `softprops/action-gh-release@v3`

---

### Task 1: Update Build Workflow

**Files:**
- Modify: `.github/workflows/build.yml`

**Interfaces:**
- Consumes: None
- Produces: Updated `.github/workflows/build.yml` targeting Node 24 compatible actions

- [ ] **Step 1: Apply version updates in build.yml**

  Modify [.github/workflows/build.yml](file:///Users/weizhoulan/Documents/git/wrapper/.github/workflows/build.yml) to update the action versions:

  ```yaml
  <<<<
        - uses: actions/checkout@v4
          with:
            ref: ${{ inputs.ref }}

        - uses: actions/setup-node@v4
          with:
            node-version: 20
            cache: npm

        - run: npm ci

        - run: npm test

        - run: npm run build:bundle
        - run: npm run build:patch

        - name: Cache pkg binaries
          uses: actions/cache@v4
  ====
        - uses: actions/checkout@v7
          with:
            ref: ${{ inputs.ref }}

        - uses: actions/setup-node@v6
          with:
            node-version: 20
            cache: npm

        - run: npm ci

        - run: npm test

        - run: npm run build:bundle
        - run: npm run build:patch

        - name: Cache pkg binaries
          uses: actions/cache@v6
  >>>>
  ```

  And:

  ```yaml
  <<<<
        - uses: actions/upload-artifact@v4
          with:
            name: ${{ matrix.artifact }}-${{ steps.ref.outputs.name }}
            path: dist/${{ matrix.artifact }}
  ====
        - uses: actions/upload-artifact@v6
          with:
            name: ${{ matrix.artifact }}-${{ steps.ref.outputs.name }}
            path: dist/${{ matrix.artifact }}
  >>>>
  ```

- [ ] **Step 2: Verify YAML syntax**

  Run: `ruby -r yaml -e "YAML.load_file('.github/workflows/build.yml')"`
  Expected: Command completes successfully with exit code 0.

- [ ] **Step 3: Commit changes**

  ```bash
  git add .github/workflows/build.yml
  git commit -m "ci: upgrade actions to Node 24 compatible versions in build workflow"
  ```

---

### Task 2: Update Pull Request Workflow

**Files:**
- Modify: `.github/workflows/pr.yml`

**Interfaces:**
- Consumes: None
- Produces: Updated `.github/workflows/pr.yml` targeting Node 24 compatible actions

- [ ] **Step 1: Apply version updates in pr.yml**

  Modify [.github/workflows/pr.yml](file:///Users/weizhoulan/Documents/git/wrapper/.github/workflows/pr.yml) to update the action versions:

  ```yaml
  <<<<
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 20
            cache: npm
  ====
      steps:
        - uses: actions/checkout@v7
        - uses: actions/setup-node@v6
          with:
            node-version: 20
            cache: npm
  >>>>
  ```

- [ ] **Step 2: Verify YAML syntax**

  Run: `ruby -r yaml -e "YAML.load_file('.github/workflows/pr.yml')"`
  Expected: Command completes successfully with exit code 0.

- [ ] **Step 3: Commit changes**

  ```bash
  git add .github/workflows/pr.yml
  git commit -m "ci: upgrade actions to Node 24 compatible versions in pr workflow"
  ```

---

### Task 3: Update Release Workflow

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: None
- Produces: Updated `.github/workflows/release.yml` targeting Node 24 compatible actions

- [ ] **Step 1: Apply version updates in release.yml**

  Modify [.github/workflows/release.yml](file:///Users/weizhoulan/Documents/git/wrapper/.github/workflows/release.yml) to update the action versions:

  ```yaml
  <<<<
        - uses: actions/checkout@v4
          with:
            ref: ${{ github.ref }}

        - uses: actions/setup-node@v4
          with:
            node-version: 20
            cache: npm

        - run: npm ci

        - run: npm test

        - run: npm run build:bundle
        - run: npm run build:patch

        - name: Cache pkg binaries
          uses: actions/cache@v4
  ====
        - uses: actions/checkout@v7
          with:
            ref: ${{ github.ref }}

        - uses: actions/setup-node@v6
          with:
            node-version: 20
            cache: npm

        - run: npm ci

        - run: npm test

        - run: npm run build:bundle
        - run: npm run build:patch

        - name: Cache pkg binaries
          uses: actions/cache@v6
  >>>>
  ```

  And:

  ```yaml
  <<<<
        - uses: actions/upload-artifact@v4
          with:
            name: ${{ matrix.artifact }}-${{ steps.ref.outputs.name }}
            path: dist/${{ matrix.artifact }}
  ====
        - uses: actions/upload-artifact@v6
          with:
            name: ${{ matrix.artifact }}-${{ steps.ref.outputs.name }}
            path: dist/${{ matrix.artifact }}
  >>>>
  ```

  And:

  ```yaml
  <<<<
      steps:
        - uses: actions/checkout@v4

        - name: Sanitize ref name
          id: ref
          run: echo "name=$(echo '${{ github.ref_name }}' | tr '/' '-')" >> $GITHUB_OUTPUT

        - uses: actions/download-artifact@v4
          with:
            pattern: wrapper-*-${{ steps.ref.outputs.name }}
            path: dist
            merge-multiple: true

        - name: Create release
          uses: softprops/action-gh-release@v2
  ====
      steps:
        - uses: actions/checkout@v7

        - name: Sanitize ref name
          id: ref
          run: echo "name=$(echo '${{ github.ref_name }}' | tr '/' '-')" >> $GITHUB_OUTPUT

        - uses: actions/download-artifact@v6
          with:
            pattern: wrapper-*-${{ steps.ref.outputs.name }}
            path: dist
            merge-multiple: true

        - name: Create release
          uses: softprops/action-gh-release@v3
  >>>>
  ```

- [ ] **Step 2: Verify YAML syntax**

  Run: `ruby -r yaml -e "YAML.load_file('.github/workflows/release.yml')"`
  Expected: Command completes successfully with exit code 0.

- [ ] **Step 3: Commit changes**

  ```bash
  git add .github/workflows/release.yml
  git commit -m "ci: upgrade actions to Node 24 compatible versions in release workflow"
  ```
