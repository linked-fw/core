---
"@_linked/core": patch
---

In the object form of select, a relation field is now typed as the node reference the row holds: `Person.select((p) => ({friend: p.bestFriend, contacts: p.friends}))` types `friend` as `{id: string}` and `contacts` as `{id: string}[]`, as the array form already did. It was typed as the shape (`Person`), so code reading `row.friend.name` compiled and got `undefined`; such code now fails to compile — select the field you need (`p.bestFriend.name`, or a sub-select). The same holds inside the object of a sub-select (`p.friends.select((f) => ({friend: f.bestFriend}))`), with `.one()` and with `.for(id)`. A sub-select keeps the object of its selected fields.
