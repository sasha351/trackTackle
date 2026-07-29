- after using the tool an adding a few songs i hit the SpotifyApiError: Spotify is rate-limiting this app (429). Wait a few minutes and reload — after heavy use the penalty can last an hour or more.

- playlist selection dropdown needs to be larger, both box size and general font

- when selecting a song's dropdown to add it to a playlist. the song that youve selected and its add button needs some sort of high
lighting because its possible to lose it among all the others. just a stand out animation when selecting the dropdown that also prevents you from clicking other add buttons (will just drop you out of the dropdown if that happens)

- look into if its possible to read playlist name / description to get a better idea of its ideal tag and genre. could help increase recommendation accuracy

- recs need to add year as a factor. if all the songs in a playlist are batched around a certain year or era that needs to be accounted for in the recommendations

- the new playlist ideas at the bottom of the sorter is weak, doesnt let you make the playlist from there and is hidden all the way at the bottom. redo its UI and look into a way to get a quick create ui / option on the table

- add a back to top button so that the user doesnt have to scroll all the way back to the top of the page manually

- songs thats currently being played needs to stand out with a highlight of some sort

- need to incorporate some light animation to give the app a more premium feel. little ones but have them all around so it feels sleek

- language matching feature is still weak. if all songs in a playlist are in one / two foreign languages that playlist should only be recommended when songs are also in that foreign language

- Valence and energy metrics from spotifys web api are not considered heavily enough, the current sorting has no feel for the mood of a track, it should. factor this into recs

- there used to be a percent match feature that we killed off. but its not entirely useless. at the top of the sorter page there should be a quick matches section that you can show / hide. if the tool finds an 85%+ match for a song it should appear here and be offered as a quick add into that playlist. it should also let the user put it in other playlists not included in the high percentage match and have all the other options

- i want to spec out another ui. the one thats there right now should stay but i want a toggle that will maybe let the user equip a prettier one. maybe with less details in view immediately. have it display the cover art of both the song and the playlist. have this be overall more minimal, more sleek, more artsy while still sticking with the ui theme of the app. it can be less space efficient but look better. the toggle for these two ui options should be i the upper right corner of the app and persist in its location with scroll.

- need duplicate prevention, if a song already exists in a playlist and a user tries to add it there should be a warning that pops up and prevents the action for happening
  
- 
