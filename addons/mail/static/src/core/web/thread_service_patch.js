/* @odoo-module */

import { ThreadService, threadService } from "@mail/core/common/thread_service";
import { parseEmail } from "@mail/utils/common/format";

import { _t } from "@web/core/l10n/translation";
import { rpc } from "@web/core/network/rpc";
import { patch } from "@web/core/utils/patch";
import { Record } from "@mail/core/common/record";
import { assignDefined, compareDatetime } from "@mail/utils/common/misc";

let nextId = 1;

patch(ThreadService.prototype, {
    /**
     * @param {import("@web/env").OdooEnv} env
     * @param {Partial<import("services").Services>} services
     */
    setup(env, services) {
        super.setup(env, services);
        this.action = services.action;
        this.activityService = services["mail.activity"];
        this.chatWindowService = services["mail.chat_window"];
    },
    /**
     * @param {import("models").Thread} thread
     * @param {['activities'|'followers'|'attachments'|'messages'|'suggestedRecipients']} requestList
     */
    async fetchData(
        thread,
        requestList = ["activities", "followers", "attachments", "messages", "suggestedRecipients"]
    ) {
        thread.isLoadingAttachments =
            thread.isLoadingAttachments || requestList.includes("attachments");
        if (requestList.includes("messages")) {
            this.fetchNewMessages(thread);
        }
        const result = await rpc("/mail/thread/data", {
            request_list: requestList,
            thread_id: thread.id,
            thread_model: thread.model,
        });
        thread.canPostOnReadonly = result.canPostOnReadonly;
        thread.hasReadAccess = result.hasReadAccess;
        thread.hasWriteAccess = result.hasWriteAccess;
        if ("activities" in result) {
            const existingIds = new Set();
            for (const activity of result.activities) {
                existingIds.add(this.store.Activity.insert(activity, { html: true }).id);
            }
            for (const activity of thread.activities) {
                if (!existingIds.has(activity.id)) {
                    this.activityService.delete(activity);
                }
            }
        }
        thread.attachments = result.attachments;
        if ("attachments" in result) {
            Object.assign(thread, {
                areAttachmentsLoaded: true,
                isLoadingAttachments: false,
            });
        }
        thread.mainAttachment = result.mainAttachment;
        if (!thread.mainAttachment && thread.attachmentsInWebClientView.length > 0) {
            this.setMainAttachmentFromIndex(thread, 0);
        }
        if ("followers" in result) {
            if (result.selfFollower) {
                thread.selfFollower = { thread, ...result.selfFollower };
            }
            thread.followersCount = result.followersCount;
            Record.MAKE_UPDATE(() => {
                for (const followerData of result.followers) {
                    const follower = this.store.Follower.insert({
                        thread,
                        ...followerData,
                    });
                    if (follower.notEq(thread.selfFollower)) {
                        thread.followers.add(follower);
                    }
                }
            });
            thread.recipientsCount = result.recipientsCount;
            for (const recipientData of result.recipients) {
                thread.recipients.add({ thread, ...recipientData });
            }
        }
        if ("suggestedRecipients" in result) {
            this.insertSuggestedRecipients(thread, result.suggestedRecipients);
        }
        return result;
    },
    getThread(model, id) {
        let thread = this.store.Thread.get({ model, id });
        if (thread) {
            if (id === false) {
                return thread;
            }
            // to force a reload
            thread.status = "new";
        }
        thread = this.store.Thread.insert({ id, model, type: "chatter" });
        if (id === false) {
            thread.messages.push({
                id: this.messageService.getNextTemporaryId(),
                author: this.store.self,
                body: _t("Creating a new record..."),
                message_type: "notification",
                trackingValues: [],
                res_id: thread.id,
                model: thread.model,
            });
        }
        return thread;
    },
    /**
     * @param {import("models").Thread} thread
     * @param {import("@mail/core/web/suggested_recipient").SuggestedRecipient[]} dataList
     */
    async insertSuggestedRecipients(thread, dataList) {
        const recipients = [];
        for (const data of dataList) {
            const [partner_id, emailInfo, lang, reason, defaultCreateValues] = data;
            let [name, email] = emailInfo ? parseEmail(emailInfo) : [];
            if ((!name || name === email) && defaultCreateValues?.name) {
                name = defaultCreateValues.name;
            }
            recipients.push({
                id: nextId++,
                name,
                email,
                lang,
                reason,
                persona: partner_id ? { type: "partner", id: partner_id } : false,
                checked: true,
                defaultCreateValues,
            });
        }
        thread.suggestedRecipients = recipients;
    },
    closeChatWindow(channel) {
        const chatWindow = this.store.discuss.chatWindows.find((c) => c.thread?.eq(channel));
        if (chatWindow) {
            this.chatWindowService.close(chatWindow, { notifyState: false });
        }
    },
    async leaveChannel(channel) {
        this.closeChatWindow(channel);
        super.leaveChannel(...arguments);
    },
    /** @param {import("models").Thread} thread */
    async loadMoreFollowers(thread) {
        const followers = await this.orm.call(thread.model, "message_get_followers", [
            [thread.id],
            thread.followers.at(-1).id,
        ]);
        Record.MAKE_UPDATE(() => {
            for (const data of followers) {
                const follower = this.store.Follower.insert({
                    thread,
                    ...data,
                });
                if (follower.notEq(thread.selfFollower)) {
                    thread.followers.add(follower);
                }
            }
        });
    },
    async loadMoreRecipients(thread) {
        const recipients = await this.orm.call(
            thread.model,
            "message_get_followers",
            [[thread.id], thread.recipients.at(-1).id],
            { filter_recipients: true }
        );
        Record.MAKE_UPDATE(() => {
            for (const data of recipients) {
                thread.recipients.add({ thread, ...data });
            }
        });
    },
    /** @override */
    open(thread, replaceNewMessageChatWindow, options) {
        if (!this.store.discuss.isActive && !this.ui.isSmall) {
            this._openChatWindow(thread, replaceNewMessageChatWindow, options);
            return;
        }
        if (this.ui.isSmall && thread.model === "discuss.channel") {
            this._openChatWindow(thread, replaceNewMessageChatWindow, options);
            return;
        }
        if (thread.model !== "discuss.channel") {
            this.action.doAction({
                type: "ir.actions.act_window",
                res_id: thread.id,
                res_model: thread.model,
                views: [[false, "form"]],
            });
            return;
        }
        super.open(thread, replaceNewMessageChatWindow);
    },
    /** @param {import("models").Follower} recipient */
    removeRecipient(recipient) {
        recipient.thread.recipients.delete(recipient);
    },
    /**
     * @param {import("models").Follower} follower
     */
    async removeFollower(follower) {
        await this.orm.call(follower.thread.model, "message_unsubscribe", [
            [follower.thread.id],
            [follower.partner.id],
        ]);
        follower.delete();
    },
    async unpin(thread) {
        const chatWindow = this.store.discuss.chatWindows.find((c) => c.thread?.eq(thread));
        if (chatWindow) {
            await this.chatWindowService.close(chatWindow);
        }
        super.unpin(...arguments);
    },
    _openChatWindow(thread, replaceNewMessageChatWindow, { openMessagingMenuOnClose } = {}) {
        const chatWindow = this.store.ChatWindow.insert(
            assignDefined(
                {
                    folded: false,
                    replaceNewMessageChatWindow,
                    thread,
                },
                {
                    openMessagingMenuOnClose,
                }
            )
        );
        chatWindow.autofocus++;
        if (thread) {
            thread.state = "open";
        }
        this.chatWindowService.notifyState(chatWindow);
    },
    getRecentChannels() {
        return Object.values(this.store.Thread.records)
            .filter((thread) => thread.model === "discuss.channel")
            .sort(
                (a, b) =>
                    compareDatetime(b.lastInterestDateTime, a.lastInterestDateTime) || b.id - a.id
            );
    },
    getNeedactionChannels() {
        return this.getRecentChannels().filter((channel) => channel.importantCounter > 0);
    },
});

patch(threadService, {
    dependencies: [...threadService.dependencies, "action", "mail.activity", "mail.chat_window"],
});
