# Organising before-click-paywalls

## What was done

Images from three folders were organised into a `category/app` folder structure.

---

## Folders processed

### 1. `aso/` (1,203 files)
Source folder: `C:\Users\chand\Downloads\before-click-paywalls\aso`

**Result — 18 categories:**
| Category | Apps |
|---|---|
| Book | 1 |
| Browser & AI | 1 |
| Education | 7 |
| Finance | 15 |
| Food & Drink | 6 |
| Games | 4 |
| Graphics & Design | 3 |
| Health & Fitness | 37 |
| Lifestyle | 18 |
| News | 1 |
| Photo & Video | 7 |
| Productivity | 24 |
| Reference | 1 |
| Social Networking | 17 |
| Sports | 4 |
| Travel | 7 |
| Utilities | 5 |
| Weather | 2 |

Total: **1,203 files** across **18 categories**

---

### 2. `onboarding/` (181 files)
Source folder: `C:\Users\chand\Downloads\before-click-paywalls\onboarding`

**Result — 8 categories:**
| Category | Apps |
|---|---|
| Education | 2 |
| Finance | 1 |
| Games | 2 |
| Health & Fitness | 3 |
| Lifestyle | 2 |
| Photo & Video | 1 |
| Productivity | 2 |
| Social Networking | 1 |

Total: **181 files** across **8 categories**

---

### 3. `paywalls/` (24 files)
Source folder: `C:\Users\chand\Downloads\before-click-paywalls\paywalls`

**Result — 7 categories:**
| Category | Apps |
|---|---|
| Education | 2 |
| Games | 1 |
| Health & Fitness | 3 |
| Lifestyle | 1 |
| Photo & Video | 2 |
| Productivity | 3 |
| Social Networking | 1 |

Total: **24 files** across **7 categories**

---

## How filenames were parsed

### Pattern
```
{app-name}-{category}-{number}.webp
```

### Examples
- `aave-finance-1.webp` → `Finance/aave/`
- `claude-by-anthropic-productivity-1.webp` → `Productivity/claude-by-anthropic/`
- `ai-calorie-tracker-by-yazio-health-&-fitness-1.webp` → `Health & Fitness/ai-calorie-tracker-by-yazio/`

### Logic
1. Split filename by `-`
2. Replace `and` with `&` in parts
3. Find the longest contiguous sequence of parts that matches a known category slug (e.g. `health-&-fitness`)
4. Everything before the category is the app name
5. `&` in category names is kept as-is
6. Aliases used for categories not in the official list (e.g. `business` → `Finance`)

### Categories (slugs)
```
productivity, health-&-fitness, social-networking, finance,
education, photo-&-video, lifestyle, food-&-drink, news,
games, sports, utilities, travel, graphics-&-design,
book, weather, reference, browser-&-ai
```

### Aliases
```
business → Finance
music → Lifestyle
medical → Health & Fitness
shopping → Lifestyle
```

---

## Scripts used
- `organize.py` — for `aso/`
- `organize_onboarding.py` — for `onboarding/`
- `organize_paywalls.py` — for `paywalls/`

All scripts are in `C:\Users\chand\Downloads\before-click-paywalls\`