# 1Password inject template for *shared* Slack operator credentials.
# Adjust vault/item/field names to match your org's shared vault.
#
# Recommended item layout (shared vault, e.g. "Comita Engineering"):
#   Item: Agent Slack Bot
#   Fields: bot_token, channel_id, signing_secret
#
# Materialize:
#   op inject -i slack.env.tpl -o ~/.config/<workspace>/slack.env --file-mode 0600
#
# Docs: https://developer.1password.com/docs/cli/secrets-config-files/

SLACK_BOT_TOKEN={{ op://Comita Engineering/Agent Slack Bot/bot_token }}
SLACK_CHANNEL_ID={{ op://Comita Engineering/Agent Slack Bot/channel_id }}
SLACK_SIGNING_SECRET={{ op://Comita Engineering/Agent Slack Bot/signing_secret }}
