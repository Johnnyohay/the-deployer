# My briefing site

A personal site that follows whatever you're interested in: a brief every morning, themes with up-to-date summaries, the names that matter, dated events coming up, and answers to your questions. Built and kept up to date by [The Deployer](https://github.com/Johnnyohay/the-deployer). No code needed.

## Get started (5 minutes)

1. **Make your copy:** click **Use this template → Create a new repository** at the top of this page. Make it **public** (GitHub Pages and Actions are free for public repos).
2. **Optional, recommended: a free AI key.** Create one at [console.groq.com/keys](https://console.groq.com/keys) (free, no card). In your new repo: **Settings → Secrets and variables → Actions → New repository secret**, name `GROQ_API_KEY`, paste the key. Without a key everything still works, using a smaller free model that runs inside GitHub, which is slower and writes less sharply.
3. **Describe what you want:** in your new repo, **Issues → New issue → Set me up**. Answer the questions and submit.

In a few minutes the issue gets a reply listing what your site follows and its link (`https://<you>.github.io/<repo>/`). If the reply says so, switch on Pages once: **Settings → Pages → Source: GitHub Actions**.

## Every day after that

The site refreshes itself each morning: new stories, a fresh brief, updated summaries, new events and names. Nothing to do.

## Change anything

- **In plain words:** open a **Change my setup** issue ("also follow X", "drop Y", "I keep seeing sports stories, keep it to retail").
- **Ask a question:** open an **Ask** issue; the answer arrives as a comment, with sources and a fact check.
- **By hand:** the settings are plain text in `topic/`. A mistake stops the build with a message naming the line, so the site never breaks.
