process.env.backend = process.cwd();
process.env.frontend = process.env.backend.replace("backend", "frontend");

import * as socket_io_server from "socket.io";
import express from "express";
import http from "http";
import cookie_session from "cookie-session";
import passport from "passport";
import crypto from "crypto";
import filesystem from "fs";
import fileupload from "express-fileupload";

const file = await import(`${process.env.backend}/model/file.mjs`);
const sql = await import(`${process.env.backend}/model/sql.mjs`);
const user = await import(`${process.env.backend}/model/user.mjs`);
const utils = await import(`${process.env.backend}/model/utils.mjs`);
const reddit = await import(`${process.env.backend}/model/reddit.mjs`);

const app = express();
const server = http.createServer(app);
const io = new socket_io_server.Server(server, {
	cors: (process.env.RUN == "dev" ? {origin: "*"} : null),
	maxHttpBufferSize: 1000000 // 1mb in bytes
});

const allowed_users = new Set(process.env.ALLOWED_USERS.split(", "));
const denied_users = new Set(process.env.DENIED_USERS.split(", "));

await file.init();
await sql.init_db();
file.cycle_backup_db();
await user.fill_usernames_to_socket_ids();
user.cycle_update_all(io);

app.use(fileupload({
	limits: {
		fileSize: 52428800 // 50mb in binary bytes
	}
}));

app.use("/", express.static(`${process.env.frontend}/build/`));

passport.serializeUser((u, done) => done(null, u.username));
passport.deserializeUser(async (username, done) => {
	try {
		const u = await user.get(username);
		done(null, u);
		console.log(`deserialized user (${username})`);
	} catch (err) {
		console.log(`deserialize error (${username})`);
		console.error(err);
		done(err, null);
	}
});
process.nextTick(() => {
	app.use((err, req, res, next) => {
		if (err) {
			console.error(err);

			const username = req.session?.passport?.user;
			if (username) {
				delete user.usernames_to_socket_ids[username];
			}

			req.session = null;
			console.log(`destroyed session (${username})`);
			req.logout();

			res.status(401).sendFile(`${process.env.frontend}/build/index.html`);
		} else {
			next();
		}
	});
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookie_session({
	name: "expanse_session",
	path: "/",
	secret: process.env.SESSION_SECRET,
	signed: true,
	httpOnly: true,
	overwrite: true,
	sameSite: "lax",
	maxAge: 1000*60*60*24*30
}));
app.use((req, res, next) => {
	req.session.nowInMinutes = Math.floor(Date.now() / 60000);
	next();
});
app.use(passport.initialize());
app.use(passport.session());

app.post("/login", async (req, res) => {
	const { session_cookie, token_v2 } = req.body;
	if (!session_cookie || !session_cookie.trim()) {
		return res.status(400).json({ error: "session_cookie required" });
	}

	const clean_session = session_cookie.trim();
	const clean_token_v2 = token_v2?.trim() || null;

	try {
		const client = reddit.create_requester(clean_session, clean_token_v2);
		const me = await client.getMe();
		const username = me?.name;

		if (!username) {
			return res.status(401).json({ error: "Invalid cookie — could not retrieve username from Reddit" });
		}

		if (
			(allowed_users.has("*") && denied_users.has(username)) ||
			(!allowed_users.has("*") && !allowed_users.has(username)) ||
			(denied_users.has("*") && !allowed_users.has(username))
		) {
			return res.status(403).json({ error: `User ${username} is not allowed` });
		}

		const u = new user.User(username, clean_session, false, clean_token_v2);
		await u.save();

		req.login(u, (loginErr) => {
			if (loginErr) {
				console.error(loginErr);
				return res.status(500).json({ error: "Session creation failed" });
			}
			res.json({ success: true, username });
		});
	} catch (err) {
		console.error(err);
		res.status(401).json({ error: "Invalid cookie or Reddit returned an error" });
	}
});

app.get("/authentication_check", (req, res) => {
	if (req.isAuthenticated()) {
		user.usernames_to_socket_ids[req.user.username] = req.query.socket_id;
		user.socket_ids_to_usernames[req.query.socket_id] = req.user.username;

		res.send({
			username: req.user.username,
			use_page: (req.user.last_updated_epoch ? "access" : "loading")
		});
	} else {
		res.send({
			use_page: "landing"
		});
	}
});

app.post("/upload", (req, res) => {
	if (req.isAuthenticated()) {
		const files = [];
		for (const name in req.files) {
			if (["saved_posts", "saved_comments", "posts", "comments", "post_votes", "hidden_posts"].includes(name)) {
				const file = req.files[name];
				files.push(file);
			}
		}
		file.parse_import(req.user.username, files).catch((err) => console.error(err));
		res.end();
	} else {
		res.status(401).sendFile(`${process.env.frontend}/build/index.html`);
	}
});

app.get("/download", (req, res) => {
	if (req.isAuthenticated()) {
		res.download(`${process.env.backend}/tempfiles/${req.query.filename}.json`, `${req.query.filename}.json`, () => {
			filesystem.promises.unlink(`${process.env.backend}/tempfiles/${req.query.filename}.json`).catch((err) => console.error(err));
		});
	} else {
		res.status(401).sendFile(`${process.env.frontend}/build/index.html`);
	}
});

app.get("/logout", (req, res) => {
	if (req.isAuthenticated()) {
		req.logout();
		res.redirect(302, "/");
	} else {
		res.status(401).sendFile(`${process.env.frontend}/build/index.html`);
	}
});

app.delete("/purge", async (req, res) => {
	if (req.isAuthenticated() && req.query.socket_id == user.usernames_to_socket_ids[req.user.username]) {
		try {
			await req.user.purge();
			req.logout();
			res.send("success");
		} catch (err) {
			console.error(err);
			res.send("error");
		}
	} else {
		res.status(401).sendFile(`${process.env.frontend}/build/index.html`);
	}
});

app.all("*", (req, res) => {
	res.status(404).sendFile(`${process.env.frontend}/build/index.html`);
});

io.on("connect", (socket) => {
	console.log(`socket (${socket.id}) connected`);

	socket.username = null;

	socket.on("route", (route) => {
		switch (route) {
			case "index":
				break;
			default:
				break;
		}
	});

	socket.on("page", async (page) => {
		switch (page) {
			case "landing":
				break;
			case "loading":
				socket.username = user.socket_ids_to_usernames[socket.id];
				try {
					const u = await user.get(socket.username);
					await u.update(io, socket.id);
				} catch (err) {
					console.error(err);
				}
				break;
			case "access":
				socket.username = user.socket_ids_to_usernames[socket.id];
				try {
					const u = await user.get(socket.username);

					io.to(socket.id).emit("store last updated epoch", u.last_updated_epoch);

					sql.update_user(u.username, {
						last_active_epoch: u.last_active_epoch = utils.now_epoch()
					}).catch((err) => console.error(err));
				} catch (err) {
					console.error(err);
				}
				break;
			default:
				break;
		}
	});

	socket.on("get data", async (filter, item_count, offset) => {
		try {
			const data = await sql.get_data(socket.username, filter, item_count, offset);
			io.to(socket.id).emit("got data", data);
		} catch (err) {
			console.error(err);
		}
	});

	socket.on("get placeholder", async (filter) => {
		try {
			const placeholder = await sql.get_placeholder(socket.username, filter);
			io.to(socket.id).emit("got placeholder", placeholder);
		} catch (err) {
			console.error(err);
		}
	});

	socket.on("get subs", async (filter) => {
		try {
			const subs = await sql.get_subs(socket.username, filter);
			io.to(socket.id).emit("got subs", subs);
		} catch (err) {
			console.error(err);
		}
	});

	socket.on("renew comment", async (comment_id) => {
		try {
			const u = await user.get(socket.username);
			const comment_content = await u.renew_comment(comment_id);
			io.to(socket.id).emit("renewed comment", comment_content);
		} catch (err) {
			console.error(err);
		}
	});

	socket.on("delete item from expanse acc", (item_id, item_category) => {
		sql.delete_item_from_expanse_acc(socket.username, item_id, item_category).catch((err) => console.error(err));
	});

	socket.on("delete item from reddit acc", async (item_id, item_category, item_type) => {
		try {
			const u = await user.get(socket.username);
			u.delete_item_from_reddit_acc(item_id, item_category, item_type).catch((err) => console.error(err));
		} catch (err) {
			console.error(err);
		}
	});

	socket.on("get whitelist", async () => {
		try {
			const data = await sql.get_whitelist_data();
			io.to(socket.id).emit("got whitelist", data);
		} catch (err) {
			console.error(err);
		}
	});

	socket.on("save whitelist", async (subs) => {
		try {
			if (!Array.isArray(subs)) {
				io.to(socket.id).emit("saved whitelist", "error");
				return;
			}
			await sql.save_whitelist(subs);
			io.to(socket.id).emit("saved whitelist");
		} catch (err) {
			console.error(err);
			io.to(socket.id).emit("saved whitelist", "error");
		}
	});

	socket.on("export", async () => {
		try {
			const filename = await file.create_export(socket.username);
			io.to(socket.id).emit("download", filename);
		} catch (err) {
			console.error(err);
		}
	});

	socket.on("disconnect", () => {
		if (socket.username) {
			(socket.username in user.usernames_to_socket_ids ? user.usernames_to_socket_ids[socket.username] = null : null);
			delete user.socket_ids_to_usernames[socket.id];
		}
	});
});

server.listen(Number.parseInt(process.env.PORT), "0.0.0.0", () => {
	console.log(`server (expanse) started on (localhost:${process.env.PORT})`);
});

process.on("beforeExit", async (exit_code) => {
	try {
		await sql.pool.end();
	} catch (err) {
		console.error(err);
	}
});
