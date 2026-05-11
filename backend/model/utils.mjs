function now_epoch() {
	const now_epoch = Math.floor(Date.now() / 1000);
	return now_epoch;
}

function epoch_to_formatted_datetime(epoch) {
	let formatted_datetime = new Date(epoch * 1000).toLocaleString("en-GB", {timeZone: "UTC", timeZoneName: "short", hour12: true}).toUpperCase().split("/").join("-").replace(",", "").replace(" AM", ":AM").replace(" PM", ":PM");
	const split = formatted_datetime.split(" ");
	(split[1][1] == ":" ? split[1] = "0"+split[1] : null);
	formatted_datetime = split.join(" ");
	return formatted_datetime;
}

function strip_trailing_slash(string) {
	const stripped_string = (string.endsWith("/") ? string.slice(0, -1) : string);
	return stripped_string;
}

function jwt_exp_secs(token) {
	try {
		return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp;
	} catch {
		return null;
	}
}

function jwt_payload(token) {
	try {
		return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
	} catch {
		return null;
	}
}

function format_duration(secs) {
	secs = Math.abs(Math.floor(secs));
	if (secs < 60)    return `${secs}s`;
	if (secs < 3600)  return `${Math.floor(secs / 60)}m`;
	if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
	return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

export {
	now_epoch,
	epoch_to_formatted_datetime,
	strip_trailing_slash,
	jwt_exp_secs,
	jwt_payload,
	format_duration
};
