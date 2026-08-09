# 1Password inject template for the *local agent GitHub App* identity.
#
# Prefer a *private* vault item for personal bots. If your team uses one
# shared org bot (e.g. addi-m), store that item in the shared vault and
# grant the Engineering group read access — still never commit resolved files.
#
# Recommended item layout:
#   Item: Agent GitHub App (<slug>)
#   Fields: app_id, client_id, installation_id, slug,
#           author_name, author_email, committer_name, committer_email
#   File attachment or field: private_key (write separately to github-app.pem)
#
# Materialize env (PEM is separate — see materialize script):
#   WORKSPACE=comita op inject -i github-app.env.tpl \
#     -o ~/.config/$WORKSPACE/github-app.env --file-mode 0600
#
# Docs: https://developer.1password.com/docs/cli/secrets-config-files/

GITHUB_APP_ID={{ op://Private/Agent GitHub App/app_id }}
GITHUB_APP_CLIENT_ID={{ op://Private/Agent GitHub App/client_id }}
GITHUB_APP_INSTALLATION_ID={{ op://Private/Agent GitHub App/installation_id }}
GITHUB_APP_SLUG={{ op://Private/Agent GitHub App/slug }}
GITHUB_APP_PRIVATE_KEY_PATH=$HOME/.config/__WORKSPACE__/github-app.pem
GIT_AUTHOR_NAME={{ op://Private/Agent GitHub App/author_name }}
GIT_AUTHOR_EMAIL={{ op://Private/Agent GitHub App/author_email }}
GIT_COMMITTER_NAME={{ op://Private/Agent GitHub App/committer_name }}
GIT_COMMITTER_EMAIL={{ op://Private/Agent GitHub App/committer_email }}
